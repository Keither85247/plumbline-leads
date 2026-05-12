'use strict';
const { google } = require('googleapis');
const db = require('../db');

// ── OAuth2 client factory ─────────────────────────────────────────────────────
// The shared oauth2Client is used ONLY for the OAuth URL generation and code
// exchange in auth.js. All per-user Gmail API calls use isolated clients
// created by loadCredentials(userId) so tokens never bleed across accounts.

function createBaseClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

// Exported for auth.js OAuth flow (URL generation + code exchange only).
// Do NOT use this for making Gmail API calls — use getClient(userId) instead.
const oauth2Client = createBaseClient();

// ── Per-user token persistence ────────────────────────────────────────────────

/**
 * Load stored tokens for a specific user and return an authenticated OAuth2 client.
 * Returns null if the user has no connected Gmail account.
 *
 * Each call creates a fresh, isolated client — no global state shared between users.
 *
 * @param {number} userId
 * @returns {{ client: OAuth2Client, row: object } | null}
 */
function loadCredentials(userId) {
  if (!userId) return null;
  const row = db.prepare('SELECT * FROM gmail_tokens WHERE user_id = ?').get(userId);
  if (!row) return null;

  const client = createBaseClient();
  client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expiry_date,
  });

  // Auto-persist refreshed tokens for this specific user only
  client.on('tokens', (tokens) => {
    console.log(`[Gmail] Access token auto-refreshed for user ${userId}`);
    db.prepare(`
      UPDATE gmail_tokens
      SET access_token = ?,
          expiry_date  = ?,
          updated_at   = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(tokens.access_token, tokens.expiry_date ?? null, userId);
  });

  return { client, row };
}

// ── Connection helpers ────────────────────────────────────────────────────────

/** Returns true only if this specific user has a connected Gmail account. */
function isConnected(userId) {
  if (!userId) return false;
  return !!db.prepare('SELECT id FROM gmail_tokens WHERE user_id = ?').get(userId);
}

/** Returns the Gmail address connected by this specific user, or null. */
function getConnectedEmail(userId) {
  if (!userId) return null;
  console.log(`[Gmail] getConnectedEmail called for user ${userId}`);
  const row = db.prepare('SELECT email FROM gmail_tokens WHERE user_id = ?').get(userId);
  return row?.email ?? null;
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
 * Clear this user's Gmail tokens from the DB.
 * Call when Google returns invalid_grant so the user sees a reconnect prompt.
 *
 * @param {number} userId
 */
function invalidateToken(userId) {
  if (!userId) return;
  db.prepare('DELETE FROM gmail_tokens WHERE user_id = ?').run(userId);
  console.warn(`[Gmail] Token invalidated for user ${userId} — must reconnect Gmail`);
}

/**
 * Returns an authenticated Gmail API client for the given user.
 * Throws if the user has no connected Gmail account.
 *
 * @param {number} userId
 */
function getClient(userId) {
  console.log(`[Gmail] getClient called for user ${userId}`);
  const result = loadCredentials(userId);
  if (!result) {
    throw new Error(`Gmail not connected for user ${userId} — run OAuth flow first`);
  }
  return google.gmail({ version: 'v1', auth: result.client });
}

// ── Email sending ─────────────────────────────────────────────────────────────

/**
 * Send an email via the authenticated Gmail account of the given user.
 *
 * @param {number} userId
 * @param {{ to, subject, body, attachments? }} params
 */
async function sendEmail(userId, { to, subject, body, attachments = [] }) {
  const result = loadCredentials(userId);
  if (!result) throw new Error('Gmail not connected — connect your account first');

  const gmail    = google.gmail({ version: 'v1', auth: result.client });
  const from     = result.row.email;
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const subjectEncoded = `=?utf-8?B?${Buffer.from(subject || '').toString('base64')}?=`;

  let raw;

  if (attachments.length === 0) {
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
      const safeName    = att.filename.replace(/[^\w.\-]/g, '_');
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

  console.log(`[Gmail] Sent email for user ${userId} to ${to}`);
  return res.data;
}

// ── Email fetching ────────────────────────────────────────────────────────────

async function listRecentMessages(userId, { sinceTimestamp } = {}) {
  const gmail = getClient(userId);
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

async function getMessageDetails(userId, messageId) {
  const gmail = getClient(userId);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id:     messageId,
    format: 'full',
  });
  return res.data;
}

// ── Message parsing helpers ───────────────────────────────────────────────────

function parseHeaders(headers = []) {
  const map = {};
  for (const { name, value } of headers) map[name.toLowerCase()] = value;
  return map;
}

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

function mailboxFromLabels(labelIds = []) {
  if (labelIds.includes('TRASH'))                                return 'trash';
  if (labelIds.includes('SPAM'))                                 return 'spam';
  if (labelIds.includes('SENT') && !labelIds.includes('INBOX')) return 'sent';
  if (labelIds.includes('INBOX'))                                return 'inbox';
  if (labelIds.includes('SENT'))                                 return 'sent';
  return 'other';
}

// ── Initial backfill ──────────────────────────────────────────────────────────

/**
 * Fetch recent Gmail history for a specific user and store in the emails table.
 * All inserted rows are stamped with the user's user_id.
 *
 * @param {number} userId
 * @param {{ daysBack?: number, maxPerLabel?: number }} options
 */
async function syncRecentEmails(userId, { daysBack = 30, maxPerLabel = 100 } = {}) {
  if (!userId) throw new Error('syncRecentEmails requires a userId');

  const result = loadCredentials(userId);
  if (!result) throw new Error(`Gmail not connected for user ${userId}`);

  const gmail          = google.gmail({ version: 'v1', auth: result.client });
  const connectedEmail = (result.row.email || '').toLowerCase();
  const sinceSeconds   = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);

  console.log(`[Backfill] Starting for user ${userId} (${connectedEmail}), ${daysBack} days back`);

  const [inboxRes, sentRes] = await Promise.all([
    gmail.users.messages.list({ userId: 'me', q: `in:inbox after:${sinceSeconds}`, maxResults: maxPerLabel }),
    gmail.users.messages.list({ userId: 'me', q: `in:sent after:${sinceSeconds}`,  maxResults: maxPerLabel }),
  ]);

  const inboxIds = new Set((inboxRes.data.messages ?? []).map(m => m.id));
  const sentIds  = new Set((sentRes.data.messages  ?? []).map(m => m.id));
  const allIds   = [...new Set([...inboxIds, ...sentIds])];

  const toFetch = allIds.filter(id =>
    !db.prepare('SELECT id FROM emails WHERE gmail_message_id = ? AND user_id = ?').get(id, userId)
  );

  console.log(`[Backfill] user=${userId}: ${allIds.length} in window, ${toFetch.length} to import`);

  const BATCH_SIZE = 10;
  let imported = 0;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (messageId) => {
      try {
        const res = await gmail.users.messages.get({
          userId: 'me', id: messageId, format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const msg      = res.data;
        const hdrs     = parseHeaders(msg.payload?.headers ?? []);
        const labelIds = msg.labelIds ?? [];
        const fromAddr = (hdrs['from'] || '').toLowerCase();
        const hasSent  = labelIds.includes('SENT');
        const direction = (fromAddr.includes(connectedEmail) || hasSent) ? 'outbound' : 'inbound';
        const is_read   = labelIds.includes('UNREAD') ? 0 : 1;
        const dateMs    = parseInt(msg.internalDate, 10) || Date.now();
        const preview   = (msg.snippet || '').slice(0, 300).replace(/\s+/g, ' ').trim();
        const mailbox   = mailboxFromLabels(labelIds);
        const status    = direction === 'outbound' ? 'sent' : 'received';

        db.prepare(`
          INSERT INTO emails
            (user_id, direction, from_address, to_address, subject,
             body_preview, status, gmail_message_id, thread_id,
             created_at, is_read, labels_json, mailbox)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          direction,
          hdrs['from']    || '',
          hdrs['to']      || '',
          hdrs['subject'] || '',
          preview,
          status,
          messageId,
          msg.threadId ?? null,
          new Date(dateMs).toISOString(),
          is_read,
          JSON.stringify(labelIds),
          mailbox,
        );
        imported++;
      } catch (err) {
        console.error(`[Backfill] user=${userId} failed on message ${messageId}:`, err.message);
      }
    }));
  }

  const skipped = allIds.length - toFetch.length;
  console.log(`[Backfill] user=${userId} done — imported ${imported}, skipped ${skipped}`);
  return { imported, skipped };
}

// ── Label backfill ────────────────────────────────────────────────────────────

/**
 * Retroactively fetch Gmail label data for emails that were imported before
 * label storage was added. Scoped to a specific user.
 *
 * @param {number} userId
 */
async function backfillMissingLabels(userId) {
  if (!userId) return { updated: 0, failed: 0 };
  if (!isConnected(userId)) return { updated: 0, failed: 0 };

  const rows = db.prepare(
    'SELECT id, gmail_message_id, direction FROM emails WHERE user_id = ? AND gmail_message_id IS NOT NULL AND labels_json IS NULL LIMIT 150'
  ).all(userId);

  if (rows.length === 0) {
    console.log(`[Backfill] user=${userId} labels already up to date`);
    return { updated: 0, failed: 0 };
  }

  console.log(`[Backfill] Fetching labels for ${rows.length} emails (user=${userId})`);

  const result = loadCredentials(userId);
  if (!result) return { updated: 0, failed: 0 };

  const gmailClient = google.gmail({ version: 'v1', auth: result.client });
  const update = db.prepare(
    'UPDATE emails SET labels_json = ?, mailbox = ?, is_read = ?, direction = ? WHERE id = ? AND user_id = ?'
  );

  let updated = 0, failed = 0;
  const BATCH = 10;

  for (let i = 0; i < rows.length; i += BATCH) {
    await Promise.all(
      rows.slice(i, i + BATCH).map(async (row) => {
        try {
          const res = await gmailClient.users.messages.get({
            userId: 'me', id: row.gmail_message_id, format: 'metadata',
            metadataHeaders: ['From'],
          });
          const labelIds  = res.data.labelIds ?? [];
          const hasSent   = labelIds.includes('SENT');
          const direction = hasSent ? 'outbound' : (row.direction ?? 'inbound');
          const is_read   = labelIds.includes('UNREAD') ? 0 : 1;
          update.run(JSON.stringify(labelIds), mailboxFromLabels(labelIds), is_read, direction, row.id, userId);
          updated++;
        } catch (err) {
          console.warn(`[Backfill] user=${userId} skipped email id=${row.id}: ${err.message}`);
          failed++;
        }
      })
    );
  }

  console.log(`[Backfill] user=${userId} labels done — updated ${updated}, failed ${failed}`);
  return { updated, failed };
}

// ── All connected users ───────────────────────────────────────────────────────

/** Returns all user_ids that currently have a gmail token. */
function getAllConnectedUserIds() {
  return db.prepare('SELECT user_id FROM gmail_tokens WHERE user_id IS NOT NULL').all().map(r => r.user_id);
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
  getAllConnectedUserIds,
};
