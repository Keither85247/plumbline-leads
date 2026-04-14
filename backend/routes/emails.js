'use strict';
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const db      = require('../db');
const gmailService = require('../services/gmailService');

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter(_req, file, cb) { cb(null, ALLOWED_MIME_TYPES.has(file.mimetype)); },
});

function normalizePhone(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// ── GET /api/emails ───────────────────────────────────────────────────────────
// TRANSITIONAL: includes NULL user_id rows (Gmail poller creates rows without a
// user_id until Phase 3 adds per-user Gmail isolation).

const VALID_MAILBOX_FILTERS = new Set(['sent', 'inbox', 'trash', 'spam']);

router.get('/', (req, res) => {
  try {
    const mb = req.query.mailbox;
    const filterClause =
      mb === 'sent'  ? "AND e.direction = 'outbound'" :
      mb === 'inbox' ? "AND e.direction = 'inbound'"  :
      mb === 'trash' ? "AND e.mailbox = 'trash'"       :
      mb === 'spam'  ? "AND e.mailbox = 'spam'"        :
      '';

    const emails = db.prepare(`
      SELECT
        e.*,
        (
          SELECT COALESCE(
            (
              SELECT l.contact_name
              FROM leads l
              WHERE
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  COALESCE(l.callback_number, l.phone_number, ''),
                  '+',''),'-',''),' ',''),'(',''),')','') = c.phone
                AND l.contact_name != 'Unknown'
                AND (l.user_id = ? OR l.user_id IS NULL)
              ORDER BY l.created_at DESC
              LIMIT 1
            ),
            c.email
          )
          FROM contacts c
          WHERE
            c.email IS NOT NULL
            AND trim(c.email) != ''
            AND (c.user_id = ? OR c.user_id IS NULL)
            AND instr(
                  lower(CASE WHEN e.direction = 'outbound'
                              THEN COALESCE(e.to_address,   '')
                              ELSE COALESCE(e.from_address, '')
                         END),
                  lower(c.email)
                ) > 0
          LIMIT 1
        ) AS contact_name
      FROM emails e
      WHERE (e.is_deleted IS NULL OR e.is_deleted = 0)
        AND (e.is_archived IS NULL OR e.is_archived = 0)
        AND (e.user_id = ? OR e.user_id IS NULL)
        ${filterClause}
      ORDER BY e.created_at DESC
      LIMIT 200
    `).all(req.userId, req.userId, req.userId);

    res.json(emails);
  } catch (err) {
    console.error('[Emails] Failed to fetch emails:', err.message);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// ── GET /api/emails/by-phone/:phone ──────────────────────────────────────────
router.get('/by-phone/:phone', (req, res) => {
  try {
    const normalized = normalizePhone(req.params.phone);
    if (!normalized) return res.json([]);

    const contactRow = db.prepare(
      'SELECT email FROM contacts WHERE phone = ? AND (user_id = ? OR user_id IS NULL)'
    ).get(normalized, req.userId);
    const contactEmail = (contactRow?.email || '').trim().toLowerCase();

    let emails;
    if (contactEmail) {
      emails = db.prepare(`
        SELECT * FROM emails
        WHERE (is_deleted IS NULL OR is_deleted = 0)
          AND (user_id = ? OR user_id IS NULL)
          AND (
            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') = ?
            OR instr(lower(from_address), ?) > 0
            OR instr(lower(to_address),   ?) > 0
          )
        ORDER BY created_at DESC
      `).all(req.userId, normalized, contactEmail, contactEmail);
    } else {
      emails = db.prepare(`
        SELECT * FROM emails
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') = ?
          AND (is_deleted IS NULL OR is_deleted = 0)
          AND (user_id = ? OR user_id IS NULL)
        ORDER BY created_at DESC
      `).all(normalized, req.userId);
    }

    res.json(emails);
  } catch (err) {
    console.error('[Emails] Failed to fetch emails by phone:', err.message);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// ── POST /api/emails ──────────────────────────────────────────────────────────
router.post('/', upload.array('attachments', 5), async (req, res) => {
  const body_raw = req.body;
  const {
    phone,
    direction    = 'outbound',
    from_address,
    to_address,
    subject,
    body,
    body_preview,
    status       = 'sent',
    external_id,
  } = body_raw;

  if (!['inbound', 'outbound'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "inbound" or "outbound"' });
  }

  const uploadedFiles  = req.files ?? [];
  const attachments    = uploadedFiles.map(f => ({ filename: f.originalname, mimeType: f.mimetype, buffer: f.buffer }));
  const attachmentsMeta = uploadedFiles.map(f => ({ filename: f.originalname, mime_type: f.mimetype, size: f.size }));

  let gmailMessageId = null;
  let threadId       = null;

  if (direction === 'outbound' && to_address && body) {
    if (!gmailService.isConnected()) {
      return res.status(400).json({ error: 'Gmail not connected. Connect your account first.' });
    }
    try {
      const sent = await gmailService.sendEmail({ to: to_address, subject: subject || '', body, attachments });
      gmailMessageId = sent.id       ?? null;
      threadId       = sent.threadId ?? null;
      console.log(`[Emails] Sent via Gmail to ${to_address} (msgId: ${gmailMessageId}, attachments: ${attachments.length})`);
    } catch (err) {
      console.error('[Emails] Gmail send failed:', err.message);
      return res.status(500).json({ error: `Gmail send failed: ${err.message}` });
    }
  }

  try {
    const preview         = body_preview ?? (body ? body.slice(0, 300) : null);
    const is_read         = direction === 'outbound' ? 1 : 0;
    const attachmentsJson = attachmentsMeta.length > 0 ? JSON.stringify(attachmentsMeta) : null;

    const result = db.prepare(`
      INSERT INTO emails
        (phone, direction, from_address, to_address, subject,
         body_preview, status, external_id, gmail_message_id, thread_id,
         is_read, attachments_json, mailbox, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      phone          || null,
      direction,
      from_address   || null,
      to_address     || null,
      subject        || null,
      preview        || null,
      status,
      external_id    || null,
      gmailMessageId,
      threadId,
      is_read,
      attachmentsJson,
      direction === 'outbound' ? 'sent' : 'inbox',
      req.userId,
    );

    const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) {
    console.error('[Emails] Failed to log email:', err.message);
    res.status(500).json({ error: 'Failed to log email' });
  }
});

// ── GET /api/emails/:id ───────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const row = db.prepare(
      'SELECT * FROM emails WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
    ).get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: 'Email not found' });
    res.json(row);
  } catch (err) {
    console.error('[Emails] Failed to fetch email:', err.message);
    res.status(500).json({ error: 'Failed to fetch email' });
  }
});

// ── PATCH /api/emails/:id ─────────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  const { is_read, is_archived, is_deleted } = req.body;
  const fields = {};

  if (is_read     !== undefined) fields.is_read     = is_read     ? 1 : 0;
  if (is_archived !== undefined) fields.is_archived = is_archived ? 1 : 0;
  if (is_deleted  !== undefined) fields.is_deleted  = is_deleted  ? 1 : 0;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values    = Object.values(fields);

  try {
    db.prepare(
      `UPDATE emails SET ${setClause} WHERE id = ? AND (user_id = ? OR user_id IS NULL)`
    ).run(...values, req.params.id, req.userId);

    const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Email not found' });
    res.json(row);
  } catch (err) {
    console.error('[Emails] Failed to update email:', err.message);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// ── DELETE /api/emails/:id ────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const info = db.prepare(
      'UPDATE emails SET is_deleted = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
    ).run(req.params.id, req.userId);
    if (info.changes === 0) return res.status(404).json({ error: 'Email not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Emails] Failed to delete email:', err.message);
    res.status(500).json({ error: 'Failed to delete email' });
  }
});

module.exports = router;
