'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const gmailService = require('../services/gmailService');

// Normalize phone to 10 digits for matching (mirrors calls.js)
function normalizePhone(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// ── GET /api/emails ───────────────────────────────────────────────────────────
// Excludes soft-deleted and archived emails.
// Enriches each row with `contact_name` by matching the counterpart address
// against contacts.email then resolving from leads.
//
// Optional query param:
//   ?mailbox=sent   → outbound messages only
//   ?mailbox=inbox  → inbound messages only
//   ?mailbox=trash  → messages with mailbox = 'trash'
//   ?mailbox=spam   → messages with mailbox = 'spam'
//   (omit for all)
//
// These four values form a whitelist; any other value is ignored (returns all).

const VALID_MAILBOX_FILTERS = new Set(['sent', 'inbox', 'trash', 'spam']);

router.get('/', (req, res) => {
  try {
    // Build a safe direction/mailbox filter from the query param.
    // Only ever inserts one of four hardcoded SQL fragments — not user input.
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
              ORDER BY l.created_at DESC
              LIMIT 1
            ),
            c.email
          )
          FROM contacts c
          WHERE
            c.email IS NOT NULL
            AND trim(c.email) != ''
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
        ${filterClause}
      ORDER BY e.created_at DESC
      LIMIT 200
    `).all();
    res.json(emails);
  } catch (err) {
    console.error('[Emails] Failed to fetch emails:', err.message);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// ── GET /api/emails/by-phone/:phone ──────────────────────────────────────────
// Returns all non-deleted emails for a contact.
// Matches on EITHER:
//   (a) the phone column on the email row (manually-logged emails), OR
//   (b) the contact's saved email address matching from_address / to_address
//       (covers Gmail-synced mail sent/received from another client).
//
// The contact email lookup uses contacts.phone = normalizedPhone,
// since ContactHistoryModal always passes the 10-digit normalised form.

router.get('/by-phone/:phone', (req, res) => {
  try {
    const normalized = normalizePhone(req.params.phone);
    if (!normalized) return res.json([]);

    // Look up this contact's email address (if any) from the profiles table.
    const contactRow   = db.prepare('SELECT email FROM contacts WHERE phone = ?').get(normalized);
    const contactEmail = (contactRow?.email || '').trim().toLowerCase();

    let emails;

    if (contactEmail) {
      // Match by phone column OR by from/to address containing the contact email.
      // INSTR handles both plain "user@example.com" and "Name <user@example.com>" formats.
      emails = db.prepare(`
        SELECT * FROM emails
        WHERE (is_deleted IS NULL OR is_deleted = 0)
          AND (
            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') = ?
            OR instr(lower(from_address), ?) > 0
            OR instr(lower(to_address),   ?) > 0
          )
        ORDER BY created_at DESC
      `).all(normalized, contactEmail, contactEmail);
    } else {
      // No email on the contact profile — fall back to phone-only match.
      emails = db.prepare(`
        SELECT * FROM emails
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') = ?
          AND (is_deleted IS NULL OR is_deleted = 0)
        ORDER BY created_at DESC
      `).all(normalized);
    }

    res.json(emails);
  } catch (err) {
    console.error('[Emails] Failed to fetch emails by phone:', err.message);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// ── POST /api/emails ──────────────────────────────────────────────────────────
// Sends an outbound email via Gmail (if connected) and logs it to the DB.
// For inbound emails logged by the poller, direction = 'inbound'.

router.post('/', async (req, res) => {
  const {
    phone,
    direction    = 'outbound',
    from_address,
    to_address,
    subject,
    body,          // full email body — used for sending only, not stored
    body_preview,  // short preview stored in DB
    status         = 'sent',
    external_id,
  } = req.body;

  if (!['inbound', 'outbound'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "inbound" or "outbound"' });
  }

  // ── Outbound: attempt to send via Gmail ────────────────────────────────────
  let gmailMessageId = null;
  let threadId       = null;

  if (direction === 'outbound' && to_address && body) {
    if (!gmailService.isConnected()) {
      return res.status(400).json({ error: 'Gmail not connected. Connect your account first.' });
    }
    try {
      const sent = await gmailService.sendEmail({
        to:      to_address,
        subject: subject || '',
        body,
      });
      gmailMessageId = sent.id       ?? null;
      threadId       = sent.threadId ?? null;
      console.log(`[Emails] Sent via Gmail to ${to_address} (msgId: ${gmailMessageId})`);
    } catch (err) {
      console.error('[Emails] Gmail send failed:', err.message);
      return res.status(500).json({ error: `Gmail send failed: ${err.message}` });
    }
  }

  // ── Persist to DB ──────────────────────────────────────────────────────────
  try {
    const preview  = body_preview ?? (body ? body.slice(0, 300) : null);
    // Outbound emails are "read" by default; inbound arrive unread.
    const is_read  = direction === 'outbound' ? 1 : 0;

    const result = db.prepare(`
      INSERT INTO emails
        (phone, direction, from_address, to_address, subject,
         body_preview, status, external_id, gmail_message_id, thread_id, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Email not found' });
    res.json(row);
  } catch (err) {
    console.error('[Emails] Failed to fetch email:', err.message);
    res.status(500).json({ error: 'Failed to fetch email' });
  }
});

// ── PATCH /api/emails/:id ─────────────────────────────────────────────────────
// Accepts: is_read, is_archived, is_deleted (as booleans or 0/1 integers)

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
    db.prepare(`UPDATE emails SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
    const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Email not found' });
    res.json(row);
  } catch (err) {
    console.error('[Emails] Failed to update email:', err.message);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// ── DELETE /api/emails/:id ────────────────────────────────────────────────────
// Soft-deletes: sets is_deleted = 1 (email remains in DB for audit trail).

router.delete('/:id', (req, res) => {
  try {
    const info = db.prepare('UPDATE emails SET is_deleted = 1 WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Email not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Emails] Failed to delete email:', err.message);
    res.status(500).json({ error: 'Failed to delete email' });
  }
});

module.exports = router;
