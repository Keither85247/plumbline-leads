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
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const calls = db.prepare(
      'SELECT * FROM calls WHERE user_id = ? ORDER BY created_at DESC LIMIT 200'
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
               AND user_id = ?
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
              AND user_id = ?
              AND contact_name IS NOT NULL
              AND contact_name != 'Unknown'
              ORDER BY created_at DESC
              LIMIT 1
            `).get(normalized, normalized, req.userId);

            if (lead) contactName = lead.contact_name;
          }
        }
      }

      // Check if an inbound missed call has a matching voicemail lead so the
      // Recent tab can show "Voicemail" instead of "Missed", link to it, and
      // the timeline can show the voicemail summary/key-points.
      //
      // IMPORTANT: use raw digit-stripping (not normalizePhone) here because
      // normalizePhone strips the leading country-code '1', giving "2037728057",
      // while the SQL REPLACE only strips symbols, leaving "12037728057".
      // Raw digits keep the full "12037728057" so both sides match.
      let voicemailLeadId       = null;
      let voicemailSummary      = null;
      let voicemailKeyPoints    = [];
      let voicemailRecordingUrl = null;

      if (c.from_number && c.classification !== 'Outbound') {
        const rawDigits = c.from_number.replace(/\D/g, '');
        if (rawDigits) {
          const vmLead = db.prepare(`
            SELECT id, summary, key_points, recording_url FROM leads
            WHERE source = 'voicemail'
              AND user_id = ?
              AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone_number,'+',''),'-',''),' ',''),'(',''),')','') = ?
              AND created_at > datetime(?, '-5 minutes')
              AND created_at < datetime(?, '+240 minutes')
            ORDER BY created_at ASC
            LIMIT 1
          `).get(req.userId, rawDigits, c.created_at, c.created_at);

          if (vmLead) {
            voicemailLeadId       = vmLead.id;
            voicemailSummary      = vmLead.summary      || null;
            voicemailKeyPoints    = vmLead.key_points
              ? JSON.parse(vmLead.key_points)
              : [];
            voicemailRecordingUrl = vmLead.recording_url || null;
          }
        }
      }

      return {
        ...c,
        contact_name:           contactName,
        key_points:             c.key_points ? JSON.parse(c.key_points) : [],
        voicemail_lead_id:      voicemailLeadId,
        voicemail_summary:      voicemailSummary,
        voicemail_key_points:   voicemailKeyPoints,
        voicemail_recording_url: voicemailRecordingUrl,
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
      'SELECT * FROM calls WHERE user_id = ? ORDER BY created_at DESC'
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
// GET /api/calls/:id/recording
// Proxies the Twilio recording for a call row using Basic auth, exactly as
// GET /api/leads/:id/voicemail does for voicemail leads.
// The browser <audio> element hits this route — Twilio credentials never leave
// the server.
// ---------------------------------------------------------------------------
router.get('/:id/recording', (req, res) => {
  const call = db.prepare(
    'SELECT recording_url FROM calls WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.userId);

  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!call.recording_url) return res.status(404).json({ error: 'No recording available for this call' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  const audioUrl = call.recording_url.endsWith('.mp3')
    ? call.recording_url
    : `${call.recording_url}.mp3`;

  const credentials     = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const protocol        = audioUrl.startsWith('https') ? require('https') : require('http');
  const upstreamHeaders = { Authorization: `Basic ${credentials}` };
  if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

  protocol.get(audioUrl, { headers: upstreamHeaders }, (twilioRes) => {
    const status = twilioRes.statusCode;
    if (status !== 200 && status !== 206) {
      twilioRes.resume();
      return res.status(502).json({ error: `Twilio returned ${status}` });
    }
    res.setHeader('Content-Type',  twilioRes.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes'); // required by Safari — declare range support unconditionally
    if (twilioRes.headers['content-length']) res.setHeader('Content-Length', twilioRes.headers['content-length']);
    if (twilioRes.headers['content-range'])  res.setHeader('Content-Range',  twilioRes.headers['content-range']);
    res.status(status);
    twilioRes.pipe(res);
  }).on('error', () => res.status(500).json({ error: 'Failed to fetch recording' }));
});

// ---------------------------------------------------------------------------
// POST /api/calls/outbound-note
//
// Persists the contractor's post-call note + outcome for ONE specific call.
//
// Critical invariant — each call interaction is its own historical row.
// A repeat call to the same contact must NEVER mutate a previous call's
// contractor_note / outcome. We rely on the Twilio CallSid (sent from the
// frontend) to pinpoint the exact row; phone-based matching is only used as
// a legacy fallback and is constrained to rows that have not been annotated.
// ---------------------------------------------------------------------------
router.post('/outbound-note', express.json(), (req, res) => {
  const { phone, note, outcome, callSid } = req.body;

  if (!phone && !callSid) {
    return res.status(400).json({ error: 'phone or callSid is required' });
  }

  const normalized     = phone ? normalizePhone(phone) : null;
  const trimmedNote    = (note || '').trim() || null;
  const trimmedOutcome = outcome || null;

  try {
    let updated = false;

    // ── Path 1 (preferred): match the EXACT call by Twilio CallSid ──────────
    // CallSid is globally unique per Twilio call. This path is race-free —
    // even if the /voice-client webhook hasn't landed yet, we know which call
    // the user just finished because the SDK gave us its CallSid.
    if (callSid) {
      const r = db.prepare(`
        UPDATE calls
        SET contractor_note = ?,
            outcome         = ?,
            user_id         = COALESCE(user_id, ?)
        WHERE call_sid = ?
          AND (user_id = ? OR user_id IS NULL)
      `).run(trimmedNote, trimmedOutcome, req.userId, callSid, req.userId);
      updated = r.changes > 0;
      if (updated) {
        console.log(`[Calls] Outbound note attached to call_sid=${callSid} (user ${req.userId})`);
      }
    }

    // ── Path 2 (legacy fallback): ONLY runs when no callSid was provided.
    //
    // CRITICAL: the `!callSid` guard is what prevents the overwrite bug.
    // Without it, a client that DID provide callSid would still fall through
    // here when Path 1 missed (e.g. /voice-client webhook hasn't landed yet),
    // and the phone match could clobber a PREVIOUS unannotated call to the
    // same number — preserving the first call's timestamp while replacing
    // its note + outcome. Modern clients always send callSid, so they go
    // straight from Path 1 to Path 3 (INSERT a new historical row) instead.
    //
    // The contractor_note / outcome IS NULL filter is a secondary defence:
    // even for true-legacy clients, we'll never overwrite an annotated row.
    if (!updated && !callSid && phone) {
      const r = db.prepare(`
        UPDATE calls
        SET contractor_note = ?,
            outcome         = ?,
            user_id         = COALESCE(user_id, ?)
        WHERE id = (
          SELECT id FROM calls
          WHERE classification = 'Outbound'
            AND (user_id = ? OR user_id IS NULL)
            AND contractor_note IS NULL
            AND outcome         IS NULL
            AND created_at > datetime('now', '-15 minutes')
            AND (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(from_number,'+',''),'-',''),' ',''),'(',''),')','') = ?
              OR
              SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(from_number,'+',''),'-',''),' ',''),'(',''),')',''), 2) = ?
            )
          ORDER BY created_at DESC
          LIMIT 1
        )
      `).run(trimmedNote, trimmedOutcome, req.userId, req.userId, normalized, normalized);
      updated = r.changes > 0;
      if (updated) {
        console.log(`[Calls] Outbound note attached via phone fallback for ${phone} (user ${req.userId})`);
      }
    }

    // ── Path 3 (last resort): no row to attach to — create a NEW historical
    // record. This is an APPEND, never a mutation. The partial UNIQUE INDEX
    // on call_sid prevents the late-arriving /voice-client webhook from
    // creating a duplicate.
    if (!updated) {
      console.warn(`[Calls] No matching row for phone=${phone} callSid=${callSid || 'none'} (user ${req.userId}) — inserting new historical record`);
      db.prepare(`
        INSERT INTO calls (from_number, call_sid, classification, contractor_note, outcome, user_id)
        VALUES (?, ?, 'Outbound', ?, ?, ?)
      `).run(normalized || phone || null, callSid || null, trimmedNote, trimmedOutcome, req.userId);
    }

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
      WHERE user_id = ?
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
