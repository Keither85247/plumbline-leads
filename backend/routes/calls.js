const express = require('express');
const router = express.Router();
const db = require('../db');

// Normalize a phone number to 10 digits for consistent matching
function normalizePhone(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// GET /api/calls — return recent incoming calls, newest first.
// Enriches each call with contact_name looked up from the leads table by
// matching the normalized from_number against phone_number / callback_number.
router.get('/', (req, res) => {
  try {
    const calls = db.prepare(
      'SELECT * FROM calls ORDER BY created_at DESC LIMIT 50'
    ).all();

    return res.json(calls.map(c => {
      let contactName = null;

      if (c.from_number) {
        const normalized = normalizePhone(c.from_number);
        if (normalized) {
          // Find the most recent lead whose phone or callback number matches
          const lead = db.prepare(`
            SELECT contact_name FROM leads
            WHERE (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone_number,    '+',''),'-',''),' ',''),'(',''),')','') = ?
              OR
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(callback_number, '+',''),'-',''),' ',''),'(',''),')','') = ?
            )
            AND contact_name IS NOT NULL
            AND contact_name != 'Unknown'
            ORDER BY created_at DESC
            LIMIT 1
          `).get(normalized, normalized);

          if (lead) contactName = lead.contact_name;
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

// GET /api/calls/by-phone/:number — return answered-call notes for a contact
router.get('/by-phone/:number', (req, res) => {
  try {
    const normalized = normalizePhone(req.params.number);
    if (!normalized) return res.json([]);

    // Fetch ALL calls — do NOT filter by transcript. Missed calls and
    // answered-but-unrecorded calls should appear in contact history too.
    const calls = db.prepare(
      'SELECT * FROM calls ORDER BY created_at DESC'
    ).all();

    const matched = calls.filter(c => normalizePhone(c.from_number) === normalized);

    return res.json(matched.map(c => ({
      ...c,
      key_points: c.key_points ? JSON.parse(c.key_points) : []
    })));
  } catch (err) {
    console.error('Error fetching calls by phone:', err);
    return res.status(500).json({ error: 'Failed to fetch call notes' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/calls/outbound-note
// Saves a contractor-written note for a just-completed outbound call.
// Matches the most recent Outbound call row by phone number and writes the
// note into `contractor_note`. If no row is found (edge case), inserts one.
// Note: outbound calls are now recorded via /voice-client → /recording, so
// the same row may also receive an AI transcript/summary from that pipeline.
// ---------------------------------------------------------------------------
router.post('/outbound-note', express.json(), (req, res) => {
  const { phone, note, outcome } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone is required' });
  }

  const normalized = normalizePhone(phone);
  const trimmedNote = (note || '').trim() || null;
  // outcome: 'answered' | 'voicemail' | 'no-answer' | null
  const trimmedOutcome = outcome || null;

  try {
    // Update the most recent Outbound call for this normalized number
    const result = db.prepare(`
      UPDATE calls
      SET contractor_note = ?, outcome = ?
      WHERE id = (
        SELECT id FROM calls
        WHERE classification = 'Outbound'
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(from_number,'+',''),'-',''),' ',''),'(',''),')','') = ?
        ORDER BY created_at DESC
        LIMIT 1
      )
    `).run(trimmedNote, trimmedOutcome, normalized);

    if (result.changes === 0) {
      // Edge case: outbound call row not found — insert a minimal record so
      // the data isn't lost. Can happen if the call dropped before being logged.
      console.warn(`[Calls] No outbound call row found for ${phone} — inserting standalone record`);
      db.prepare(
        'INSERT INTO calls (from_number, classification, contractor_note, outcome) VALUES (?, ?, ?, ?)'
      ).run(phone, 'Outbound', trimmedNote, trimmedOutcome);
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
// Marks all unseen missed inbound calls (within 48h) as seen.
// Called when the contractor opens the Recent calls tab.
// ---------------------------------------------------------------------------
router.post('/mark-seen', (req, res) => {
  try {
    db.prepare(`
      UPDATE calls
      SET is_seen = 1
      WHERE classification != 'Outbound'
        AND (duration IS NULL OR duration = 0)
        AND transcript IS NULL
        AND created_at > datetime('now', '-48 hours')
        AND is_seen = 0
    `).run();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Calls] mark-seen error:', err.message);
    return res.status(500).json({ error: 'Failed to mark calls as seen' });
  }
});

module.exports = router;
