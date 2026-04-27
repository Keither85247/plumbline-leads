'use strict';
const db    = require('../db');
const gmail = require('../services/gmailService');

// ── Durable lastPollTime ──────────────────────────────────────────────────────
// Persisted in app_settings so server restarts don't lose our position.
// Without this, every restart resets the window to "1 hour ago" and misses
// any emails that arrived before the last restart.

function loadLastPollTime() {
  // Try the persisted checkpoint first
  const saved = db.prepare(
    "SELECT value FROM app_settings WHERE key = 'gmail_last_poll_time'"
  ).get();
  if (saved?.value) {
    const ms = parseInt(saved.value, 10);
    if (!isNaN(ms) && ms > 0) return ms;
  }
  // Fall back to the newest stored email's timestamp (minus 5 min buffer for
  // clock skew / delivery delay) so the first post-restart poll picks up
  // anything that arrived after the last successfully stored message.
  const row = db.prepare(
    "SELECT MAX(created_at) AS ts FROM emails WHERE gmail_message_id IS NOT NULL"
  ).get();
  if (row?.ts) {
    return Math.max(0, new Date(row.ts).getTime() - 5 * 60 * 1000);
  }
  // No emails at all — look back 1 hour
  return Date.now() - 60 * 60 * 1000;
}

function saveLastPollTime(ms) {
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('gmail_last_poll_time', ?)"
  ).run(String(ms));
}

let lastPollTime = loadLastPollTime();

/**
 * Fetch new message stubs for a given Gmail query since lastPollTime.
 * Returns an array of message IDs that are not yet in the DB.
 */
async function fetchNewIds(gmailClient, query) {
  const sinceSeconds = Math.floor(lastPollTime / 1000);
  const res = await gmailClient.users.messages.list({
    userId:     'me',
    q:          `${query} after:${sinceSeconds}`,
    maxResults: 50,
  });
  const stubs = res.data.messages ?? [];
  return stubs
    .map(s => s.id)
    .filter(id => !db.prepare('SELECT id FROM emails WHERE gmail_message_id = ?').get(id));
}

async function poll() {
  if (!gmail.isConnected()) return;

  const pollStart      = Date.now();
  const connectedEmail = (gmail.getConnectedEmail() || '').toLowerCase();
  console.log('[Poller] Checking Gmail for new messages…');

  try {
    const gmailClient = gmail.getClient();

    // ── Collect new IDs from both inbox and sent ───────────────────────────
    const [newInboxIds, newSentIds] = await Promise.all([
      fetchNewIds(gmailClient, 'in:inbox'),
      fetchNewIds(gmailClient, 'in:sent'),
    ]);

    // Dedupe: a message might appear in both (e.g. sent to yourself)
    const allNewIds = [...new Set([...newInboxIds, ...newSentIds])];

    if (allNewIds.length === 0) {
      console.log('[Poller] No new messages.');
      lastPollTime = pollStart;
      saveLastPollTime(pollStart);
      return;
    }

    console.log(`[Poller] ${allNewIds.length} new message(s) to store.`);

    // ── Fetch full details and store ───────────────────────────────────────
    for (const messageId of allNewIds) {
      try {
        const msg      = await gmail.getMessageDetails(messageId);
        const hdrs     = gmail.parseHeaders(msg.payload?.headers ?? []);
        const labelIds = msg.labelIds ?? [];

        const fromAddr  = (hdrs['from'] || '').toLowerCase();
        const hasSent   = labelIds.includes('SENT');
        const direction = (fromAddr.includes(connectedEmail) || hasSent) ? 'outbound' : 'inbound';

        const is_read   = labelIds.includes('UNREAD') ? 0 : 1;

        const preview = (msg.snippet || gmail.extractPlainText(msg.payload) || '')
          .slice(0, 300)
          .replace(/\s+/g, ' ')
          .trim();

        const dateMs      = parseInt(msg.internalDate, 10) || Date.now();
        const createdAt   = new Date(dateMs).toISOString();
        const labelsJson  = JSON.stringify(labelIds);
        const mailbox     = gmail.mailboxFromLabels(labelIds);
        const status      = direction === 'outbound' ? 'sent' : 'received';

        db.prepare(`
          INSERT INTO emails
            (direction, from_address, to_address, subject,
             body_preview, status, gmail_message_id, thread_id,
             created_at, is_read, labels_json, mailbox)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          direction,
          hdrs['from']    || '',
          hdrs['to']      || '',
          hdrs['subject'] || '',
          preview,
          status,
          messageId,
          msg.threadId ?? null,
          createdAt,
          is_read,
          labelsJson,
          mailbox,
        );

        console.log(`[Poller] Stored [${direction}]: "${hdrs['subject']}" ${direction === 'outbound' ? 'to' : 'from'} ${direction === 'outbound' ? hdrs['to'] : hdrs['from']}`);
      } catch (msgErr) {
        console.error(`[Poller] Failed to fetch message ${messageId}:`, msgErr.message);
      }
    }

    lastPollTime = pollStart;
    saveLastPollTime(pollStart);
  } catch (err) {
    console.error('[Poller] Poll error:', err.message);
    // Do NOT update lastPollTime on error — next poll will retry the same window
  }
}

/**
 * Start the Gmail polling loop.
 * @param {number} intervalMs  Poll interval in ms (default 60 seconds)
 * @returns The setInterval handle (call clearInterval to stop)
 */
function startPolling(intervalMs = 60_000) {
  console.log(`[Poller] Gmail polling every ${intervalMs / 1000}s — resuming from ${new Date(lastPollTime).toISOString()}`);
  poll().catch(err => console.error('[Poller] Initial poll failed:', err.message));
  return setInterval(
    () => poll().catch(err => console.error('[Poller] Poll failed:', err.message)),
    intervalMs,
  );
}

module.exports = { startPolling, poll };
