'use strict';
const { google } = require('googleapis');
const db = require('../db');

// ── OAuth2 client ─────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

// ── Token persistence ─────────────────────────────────────────────────────────

/**
 * Load stored tokens from DB and apply to the OAuth2 client.
 * Returns the DB row, or null if not connected.
 */
function loadCredentials() {
  const row = db.prepare('SELECT * FROM gmail_tokens ORDER BY id LIMIT 1').get();
  if (!row) return null;
  oauth2Client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expiry_date,
  });
  return row;
}

// When googleapis auto-refreshes an expired access token, persist the new one.
oauth2Client.on('tokens', (tokens) => {
  const row = db.prepare('SELECT id FROM gmail_tokens ORDER BY id LIMIT 1').get();
  if (!row) return;
  db.prepare(`
    UPDATE gmail_tokens
    SET access_token = ?,
        expiry_date  = ?,
        updated_at   = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(tokens.access_token, tokens.expiry_date ?? null, row.id);
});

// ── Connection helpers ────────────────────────────────────────────────────────

function isConnected() {
  return !!db.prepare('SELECT id FROM gmail_tokens LIMIT 1').get();
}

/**
 * Returns true if the error is an OAuth invalid_grant — meaning the refresh
 * token has been revoked or expired and cannot be used again.
 */
function isInvalidGrant(err) {
  const data = err?.response?.data;
  if (data?.error === 'invalid_grant') return true;
  if (err?.message?.toLowerCase().includes('invalid_grant')) return true;
  return false;
}

/**
 * Clear all stored Gmail tokens from the DB.
 * Call this when Google returns invalid_grant so the app knows Gmail is
 * disconnected and the user sees a reconnect prompt instead of silent errors.
 */
function invalidateToken() {
  db.prepare('DELETE FROM gmail_tokens').run();
  console.warn('[Gmail] Token invalidated — user must reconnect Gmail');
}

function getConnectedEmail() {
  const row = db.prepare('SELECT email FROM gmail_tokens LIMIT 1').get();
  return row?.email ?? null;
}

/** Returns an authenticated Gmail API client, throws if not connected. */
function getClient() {
  if (!loadCredentials()) {
    throw new Error('Gmail not connected — run OAuth flow first');
  }
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ── Email sending ─────────────────────────────────────────────────────────────

/**
 * Send an email via the authenticated Gmail account.
 * Builds RFC 2822 / MIME multipart when attachments are provided,
 * otherwise sends a simple text/plain message.
 *
 * @param {{
 *   to:          string,
 *   subject:     string,
 *   body:        string,
 *   attachments?: Array<{ filename: string, mimeType: string, buffer: Buffer }>
 * }} params
 * @returns {{ id: string, threadId: string }} Gmail message object
 */
async function sendEmail({ to, subject, body, attachments = [] }) {
  const gmail    = getClient();
  const from     = getConnectedEmail();
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const subjectEncoded = `=?utf-8?B?${Buffer.from(subject || '').toString('base64')}?=`;

  let raw;

  if (attachments.length === 0) {
    // ── Plain text — no attachments ───────────────────────────────────────────
    const parts = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subjectEncoded}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body || '').toString('base64'),
    ];
    raw = Buffer.from(parts.join('\r\n')).toString('base64url');
  } else {
    // ── Multipart/mixed — body + attachments ──────────────────────────────────
    const crlf = '\r\n';
    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subjectEncoded}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body || '').toString('base64'),
    ];

    for (const att of attachments) {
      // Sanitise filename (no path traversal, ASCII-safe)
      const safeName = att.filename.replace(/[^\w.\-]/g, '_');
      const nameEncoded = `=?utf-8?B?${Buffer.from(att.filename).toString('base64')}?=`;
      lines.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${nameEncoded}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"`,
        '',
        att.buffer.toString('base64'),
      );
    }

    lines.push(`--${boundary}--`);
    raw = Buffer.from(lines.join(crlf)).toString('base64url');
  }

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return res.data; // { id, threadId, labelIds }
}

// ── Email fetching ────────────────────────────────────────────────────────────

/**
 * List message stubs from Gmail inbox since `sinceTimestamp` (ms epoch).
 * Default lookback: 24 hours.
 *
 * @param {{ sinceTimestamp?: number }} options
 * @returns Array of { id, threadId } stubs
 */
async function listRecentMessages({ sinceTimestamp } = {}) {
  const gmail = getClient();

  const sinceSeconds = sinceTimestamp
    ? Math.floor(sinceTimestamp / 1000)
    : Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

  const res = await gmail.users.messages.list({
    userId:     'me',
    q:          `in:inbox after:${sinceSeconds}`,
    maxResults: 50,
  });

  return res.data.messages ?? [];
}

/**
 * Fetch full message payload for a given Gmail message ID.
 * @param {string} messageId
 */
async function getMessageDetails(messageId) {
  const gmail = getClient();
  const res = await gmail.users.messages.get({
    userId: 'me',
    id:     messageId,
    format: 'full',
  });
  return res.data;
}

// ── Message parsing helpers ───────────────────────────────────────────────────

/**
 * Convert Gmail header array to a plain { name: value } map (lowercase keys).
 */
function parseHeaders(headers = []) {
  const map = {};
  for (const { name, value } of headers) {
    map[name.toLowerCase()] = value;
  }
  return map;
}

/**
 * Recursively extract the first text/plain part from a message payload.
 * Returns the decoded string, or null if none found.
 */
function extractPlainText(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  return null;
}

/**
 * Derive a normalised mailbox bucket from Gmail label IDs.
 * Priority: trash > spam > sent (exclusive) > inbox > other.
 *
 * @param {string[]} labelIds
 * @returns {'inbox'|'sent'|'trash'|'spam'|'other'}
 */
function mailboxFromLabels(labelIds = []) {
  if (labelIds.includes('TRASH'))                                         return 'trash';
  if (labelIds.includes('SPAM'))                                          return 'spam';
  if (labelIds.includes('SENT') && !labelIds.includes('INBOX'))          return 'sent';
  if (labelIds.includes('INBOX'))                                         return 'inbox';
  if (labelIds.includes('SENT'))                                          return 'sent';
  return 'other';
}

// ── Initial backfill ──────────────────────────────────────────────────────────

/**
 * Fetch recent Gmail history and store it in the emails table.
 * Uses metadata-only format (headers + snippet) for speed — no body download.
 * Called once after OAuth connect; the regular poller handles incremental sync.
 *
 * @param {{ daysBack?: number, maxPerLabel?: number }} options
 *   daysBack     — how far back to look (default 30 days)
 *   maxPerLabel  — cap on inbox messages AND on sent messages (default 100 each)
 * @returns {{ imported: number, skipped: number }}
 */
async function syncRecentEmails({ daysBack = 30, maxPerLabel = 100 } = {}) {
  const gmail          = getClient();
  const connectedEmail = (getConnectedEmail() || '').toLowerCase();
  const sinceSeconds   = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);

  // ── 1. List stubs from inbox + sent in parallel ────────────────────────────
  const [inboxRes, sentRes] = await Promise.all([
    gmail.users.messages.list({
      userId:     'me',
      q:          `in:inbox after:${sinceSeconds}`,
      maxResults: maxPerLabel,
    }),
    gmail.users.messages.list({
      userId:     'me',
      q:          `in:sent after:${sinceSeconds}`,
      maxResults: maxPerLabel,
    }),
  ]);

  const inboxIds = new Set((inboxRes.data.messages ?? []).map(m => m.id));
  const sentIds  = new Set((sentRes.data.messages  ?? []).map(m => m.id));

  // Merge, dedupe stub IDs; remember which label each came from for direction
  const allIds = [...new Set([...inboxIds, ...sentIds])];

  // ── 2. Skip already-stored messages ───────────────────────────────────────
  const toFetch = allIds.filter(id =>
    !db.prepare('SELECT id FROM emails WHERE gmail_message_id = ?').get(id)
  );

  console.log(`[Backfill] ${allIds.length} msgs in window, ${toFetch.length} new to import`);

  // ── 3. Fetch metadata in parallel batches of 10 ───────────────────────────
  const BATCH_SIZE = 10;
  let imported = 0;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (messageId) => {
      try {
        const res = await gmail.users.messages.get({
          userId:          'me',
          id:              messageId,
          format:          'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const msg      = res.data;
        const hdrs     = parseHeaders(msg.payload?.headers ?? []);
        const labelIds = msg.labelIds ?? [];

        // Direction: outbound if From matches connected account, OR if SENT label present
        const fromAddr  = (hdrs['from'] || '').toLowerCase();
        const hasSent   = labelIds.includes('SENT');
        const direction = (fromAddr.includes(connectedEmail) || hasSent) ? 'outbound' : 'inbound';

        // is_read: 1 unless UNREAD label is present (and it's an inbound message)
        const is_read   = labelIds.includes('UNREAD') ? 0 : 1;

        const dateMs      = parseInt(msg.internalDate, 10) || Date.now();
        const preview     = (msg.snippet || '').slice(0, 300).replace(/\s+/g, ' ').trim();
        const createdAt   = new Date(dateMs).toISOString();
        const labelsJson  = JSON.stringify(labelIds);
        const mailbox     = mailboxFromLabels(labelIds);
        // status: 'sent' for outbound, 'received' for inbound
        const status      = direction === 'outbound' ? 'sent' : 'received';

        db.prepare(`
          INSERT INTO emails
            (direction, from_address, to_address, subject,
             body_preview, status, gmail_message_id, thread_id,
             created_at, is_read, labels_json, mailbox)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

        imported++;
      } catch (err) {
        console.error(`[Backfill] Failed on message ${messageId}:`, err.message);
      }
    }));
  }

  const skipped = allIds.length - toFetch.length;
  console.log(`[Backfill] Done — imported ${imported}, skipped ${skipped} already-stored`);
  return { imported, skipped };
}

// ── Label backfill ────────────────────────────────────────────────────────────

/**
 * Retroactively fetch and store Gmail label data for emails that were imported
 * before label storage was added (labels_json IS NULL but gmail_message_id IS NOT NULL).
 *
 * Runs at startup after OAuth tokens are available. Safe to call repeatedly —
 * it only touches rows that still have null labels_json.
 *
 * @returns {{ updated: number, failed: number }}
 */
async function backfillMissingLabels() {
  if (!isConnected()) return { updated: 0, failed: 0 };

  const rows = db.prepare(
    'SELECT id, gmail_message_id, direction FROM emails WHERE gmail_message_id IS NOT NULL AND labels_json IS NULL LIMIT 150'
  ).all();

  if (rows.length === 0) {
    console.log('[Backfill] Labels already up to date — nothing to do.');
    return { updated: 0, failed: 0 };
  }

  console.log(`[Backfill] Fetching labels for ${rows.length} emails…`);

  const gmailClient     = getClient();
  const connectedEmail  = (getConnectedEmail() || '').toLowerCase();
  const update          = db.prepare(
    'UPDATE emails SET labels_json = ?, mailbox = ?, is_read = ?, direction = ? WHERE id = ?'
  );

  let updated = 0;
  let failed  = 0;

  // Process in small batches to avoid hammering the Gmail API
  const BATCH = 10;
  for (let i = 0; i < rows.length; i += BATCH) {
    await Promise.all(
      rows.slice(i, i + BATCH).map(async (row) => {
        try {
          const res = await gmailClient.users.messages.get({
            userId:          'me',
            id:              row.gmail_message_id,
            format:          'metadata',
            metadataHeaders: ['From'],
          });
          const msg      = res.data;
          const labelIds = msg.labelIds ?? [];
          const fromAddr = '';  // already stored; just need labels
          const hasSent  = labelIds.includes('SENT');

          // Only correct direction if we can confirm from labels
          const direction = hasSent
            ? 'outbound'
            : (row.direction ?? 'inbound');

          const is_read     = labelIds.includes('UNREAD') ? 0 : 1;
          const labelsJson  = JSON.stringify(labelIds);
          const mailbox     = mailboxFromLabels(labelIds);

          update.run(labelsJson, mailbox, is_read, direction, row.id);
          updated++;
        } catch (err) {
          console.warn(`[Backfill] Skipped email id=${row.id}: ${err.message}`);
          failed++;
        }
      })
    );
  }

  console.log(`[Backfill] Labels done — updated ${updated}, failed ${failed}`);
  return { updated, failed };
}

module.exports = {
  oauth2Client,
  loadCredentials,
  isConnected,
  isInvalidGrant,
  invalidateToken,
  getConnectedEmail,
  getClient,
  sendEmail,
  listRecentMessages,
  getMessageDetails,
  parseHeaders,
  extractPlainText,
  mailboxFromLabels,
  syncRecentEmails,
  backfillMissingLabels,
};
