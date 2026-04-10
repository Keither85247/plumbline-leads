const express = require('express');
const router = express.Router();
const db = require('../db');

// Lazy-load twilio client so the route still works if TWILIO_* vars are missing
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  const twilio = require('twilio');
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Normalize to E.164 or 10-digit for consistent storage + matching
function normalizePhone(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return num.trim();
}

// ---------------------------------------------------------------------------
// GET /api/messages
// Returns a deduplicated conversation list — one entry per unique phone number,
// with the most-recent message preview and unread count.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    // One row per phone: latest message body + ts + unread count
    const rows = db.prepare(`
      SELECT
        m.phone,
        m.body         AS lastMessage,
        m.direction    AS lastMessageDir,
        m.created_at   AS timestamp,
        SUM(CASE WHEN m.direction = 'inbound' AND m2.id IS NULL THEN 1 ELSE 0 END) AS unread,
        -- resolve contact name from leads table
        (SELECT contact_name FROM leads
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone_number,'+',''),'-',''),' ',''),'(',''),')','')
              = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(m.phone,'+',''),'-',''),' ',''),'(',''),')','')
            AND contact_name IS NOT NULL AND contact_name != 'Unknown'
          ORDER BY created_at DESC LIMIT 1) AS contact_name
      FROM messages m
      -- left-join to find messages that haven't been "read" (no outbound reply after them)
      LEFT JOIN messages m2
        ON m2.phone = m.phone AND m2.direction = 'outbound' AND m2.created_at >= m.created_at
      WHERE m.id = (
        SELECT id FROM messages m3 WHERE m3.phone = m.phone ORDER BY created_at DESC LIMIT 1
      )
      GROUP BY m.phone
      ORDER BY m.created_at DESC
    `).all();

    return res.json(rows.map(r => {
      // Normalize to 10-digit for contacts table lookup (contacts PK is always 10-digit)
      const digits = (r.phone || '').replace(/\D/g, '');
      const normalized10 = (digits.length === 11 && digits[0] === '1') ? digits.slice(1) : digits;

      // Priority 1: contractor-saved name from contacts table
      const contact = normalized10
        ? db.prepare(`SELECT name FROM contacts WHERE phone = ? AND name IS NOT NULL AND trim(name) != ''`).get(normalized10)
        : null;

      return {
        id:             r.phone,
        phone:          r.phone,
        name:           contact?.name || r.contact_name || r.phone,
        lastMessage:    r.lastMessage,
        lastMessageDir: r.lastMessageDir,
        timestamp:      r.timestamp,
        unread:         r.unread ?? 0,
      };
    }));
  } catch (err) {
    console.error('[Messages] GET / error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/messages/:phone
// Returns all messages for a single conversation, oldest first.
// ---------------------------------------------------------------------------
router.get('/:phone', (req, res) => {
  try {
    const phone = normalizePhone(decodeURIComponent(req.params.phone));
    if (!phone) return res.json([]);

    const messages = db.prepare(`
      SELECT * FROM messages
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','')
          = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(?,'+',''),'-',''),' ',''),'(',''),')','')
      ORDER BY created_at ASC
    `).all(phone);

    return res.json(messages);
  } catch (err) {
    console.error('[Messages] GET /:phone error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/messages/:phone/read
// Marks all inbound messages from a phone as read (is_read = 1).
// Called when the contractor opens a conversation thread.
// ---------------------------------------------------------------------------
router.patch('/:phone/read', (req, res) => {
  try {
    const phone = normalizePhone(decodeURIComponent(req.params.phone));
    if (!phone) return res.json({ ok: true });

    db.prepare(`
      UPDATE messages
      SET is_read = 1
      WHERE direction = 'inbound'
        AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','')
          = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(?,'+',''),'-',''),' ',''),'(',''),')','')
    `).run(phone);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[Messages] PATCH /:phone/read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages/send
// Sends an outbound SMS via Twilio and persists it to the messages table.
// Body: { to: string, body: string }
// ---------------------------------------------------------------------------
router.post('/send', express.json(), async (req, res) => {
  const { to, body } = req.body;

  if (!to || !body?.trim()) {
    return res.status(400).json({ error: 'to and body are required' });
  }

  const toE164 = normalizePhone(to);
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!fromNumber) {
    return res.status(500).json({ error: 'TWILIO_PHONE_NUMBER is not configured' });
  }

  const client = getTwilioClient();
  if (!client) {
    return res.status(500).json({ error: 'Twilio credentials are not configured' });
  }

  try {
    const message = await client.messages.create({
      body: body.trim(),
      from: fromNumber,
      to:   toE164,
    });

    // Persist to DB
    const row = db.prepare(`
      INSERT INTO messages (phone, direction, body, twilio_sid, status)
      VALUES (?, 'outbound', ?, ?, ?)
    `).run(toE164, body.trim(), message.sid, message.status || 'sent');

    console.log(`[Messages] Sent SMS to ${toE164} — SID: ${message.sid}`);
    return res.json({ ok: true, id: row.lastInsertRowid, sid: message.sid });
  } catch (err) {
    console.error('[Messages] Twilio send error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
