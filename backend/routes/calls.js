const express = require('express');
const router = express.Router();
const db = require('../db');

function normalizePhone(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// ---------------------------------------------------------------------------
// GET /api/calls
// TRANSITIONAL: includes NULL user_id rows (Twilio webhook-created calls) until
// Phase 2 assigns those rows to the correct user via Twilio number routing.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const calls = db.prepare(
      'SELECT * FROM calls WHERE (user_id = ? OR user_id IS NULL) ORDER BY created_at DESC LIMIT 50'
    ).all(req.userId);

    return res.json(calls.map(c => {
      let contactName = null;

      if (c.from_number) {
        const normalized = normalizePhone(c.from_number);
        if (normalized) {
          // Priority 1: contractor-saved name from contacts table
          const contact = db.prepare(
            `SELECT name FROM contacts
             WHERE phone = ?
               AND (user_id = ? OR user_id IS NULL)
               AND name IS NOT NULL AND trim(name) != ''`
          ).get(normalized, req.userId);

          if (contact) {
            contactName = contact.name;
          } else {
            // Priority 2: AI-extracted name from leads table
            const lead = db.prepare(`
              SELECT contact_name FROM leads
              WHERE (
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone_number,    '+',''),'-',''),' ',''),'(',''),')','') = ?
                OR
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(callback_number, '+',''),'-',''),' ',''),'(',''),')','') = ?
              )
              AND (user_id = ? OR user_id IS NULL)
              AND contact_name IS NOT NULL
              AND contact_name != 'Unknown'
              ORDER BY created_at DESC
              LIMIT 1
            `).get(normalized, normalized, req.userId);

            if (lead) contactName = lead.contact_name;
          }
        }
      }

      return {
        ...c,
        contact_name: contactName,
        key_points: c.key_points ? JSON.parse(c.key_points) : [],
      };
    }));
  } catch (err) {
    console.error('Error fetching calls:', err);
    return res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/calls/by-phone/:number
// ---------------------------------------------------------------------------
router.get('/by-phone/:number', (req, res) => {
  try {
    const normalized = normalizePhone(req.params.number);
    if (!normalized) return res.json([]);

    const calls = db.prepare(
      'SELECT * FROM calls WHERE (user_id = ? OR user_id IS NULL) ORDER BY created_at DESC'
    ).all(req.userId);

    const matched = calls.filter(c => normalizePhone(c.from_number) === normalized);

    return res.json(matched.map(c => ({
      ...c,
      key_points: c.key_points ? JSON.parse(c.key_points) : [],
    })));
  } catch (err) {
    console.error('Error fetching calls by phone:', err);
    return res.status(500).json({ error: 'Failed to fetch call notes' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/calls/outbound-note
// ---------------------------------------------------------------------------
router.post('/outbound-note', express.json(), (req, res) => {
  const { phone, note, outcome } = req.body;

  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const normalized    = normalizePhone(phone);
  const trimmedNote   = (note || '').trim() || null;
  const trimmedOutcome = outcome || null;

  try {
    const result = db.prepare(`
      UPDATE calls
      SET contractor_note = ?, outcome = ?
      WHERE id = (
        SELECT id FROM calls
        WHERE classification = 'Outbound'
          AND (user_id = ? OR user_id IS NULL)
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(from_number,'+',''),'-',''),' ',''),'(',''),')','') = ?
        ORDER BY created_at DESC
        LIMIT 1
      )
    `).run(trimmedNote, trimmedOutcome, req.userId, normalized);

    if (result.changes === 0) {
      console.warn(`[Calls] No outbound call row found for ${phone} — inserting standalone record`);
      db.prepare(
        'INSERT INTO calls (from_number, classification, contractor_note, outcome, user_id) VALUES (?, ?, ?, ?, ?)'
      ).run(phone, 'Outbound', trimmedNote, trimmedOutcome, req.userId);
    }

    console.log(`[Calls] Outbound record saved for ${phone} — outcome: ${trimmedOutcome || 'none'}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Calls] Failed to save outbound note:', err.message);
    return res.status(500).json({ error: 'Failed to save note' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/calls/mark-seen
// ---------------------------------------------------------------------------
router.post('/mark-seen', (req, res) => {
  try {
    db.prepare(`
      UPDATE calls
      SET is_seen = 1
      WHERE (user_id = ? OR user_id IS NULL)
        AND classification != 'Outbound'
        AND (duration IS NULL OR duration = 0)
        AND transcript IS NULL
        AND created_at > datetime('now', '-48 hours')
        AND is_seen = 0
    `).run(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Calls] mark-seen error:', err.message);
    return res.status(500).json({ error: 'Failed to mark calls as seen' });
  }
});

module.exports = router;
