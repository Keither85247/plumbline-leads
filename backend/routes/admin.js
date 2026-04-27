'use strict';
const express      = require('express');
const router       = express.Router();
const twilio       = require('twilio');
const db           = require('../db');
const requireOwner = require('../middleware/requireOwner');
const { seedDemoData } = require('../scripts/seed-demo');

// DEMO_EMAIL identifies the demo account. Set this env var on Render if you
// want to use a different address; defaults match the create-user suggestion.
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@plumblineleads.com';

// ── POST /api/admin/reset-demo ────────────────────────────────────────────────
// Wipes all data rows owned by the demo user and re-seeds with fake demo data.
// Call this before handing a demo login to someone.

router.post('/reset-demo', requireOwner, (req, res) => {
  const demoUser = db.prepare('SELECT id, email FROM users WHERE email = ?').get(DEMO_EMAIL);

  if (!demoUser) {
    return res.status(404).json({
      error: `Demo user not found. Expected email: ${DEMO_EMAIL}. ` +
             'Create the account with: node scripts/create-user.js',
    });
  }

  const uid = demoUser.id;

  // Wipe all demo user's data in a single transaction
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM leads    WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM calls    WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM emails   WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM contacts WHERE user_id = ?').run(uid);
  });

  try {
    wipe();
    seedDemoData(uid);
    console.log(`[Admin] Demo data reset by user ${req.userId} — demo user: ${demoUser.email} (id ${uid})`);
    res.json({ ok: true, demoUserId: uid, demoEmail: demoUser.email });
  } catch (err) {
    console.error('[Admin] reset-demo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
// Returns all user accounts so you can see who exists without touching the DB directly.

router.get('/users', requireOwner, (_req, res) => {
  const users = db.prepare(`
    SELECT id, email, display_name, is_owner, created_at
    FROM users
    ORDER BY id
  `).all();
  res.json(users);
});

// ── POST /api/admin/gmail-sync ────────────────────────────────────────────────
// Triggers an immediate Gmail backfill for the past `days` days (default 60).
// Useful when the poller fell behind due to a server restart losing lastPollTime.

const { syncRecentEmails } = require('../services/gmailService');

router.post('/gmail-sync', requireOwner, express.json(), async (req, res) => {
  const daysBack = Math.min(parseInt(req.body?.days, 10) || 60, 180);
  try {
    const result = await syncRecentEmails({ daysBack, maxPerLabel: 200 });
    console.log(`[Admin] Manual Gmail sync by user ${req.userId}: imported ${result.imported}, skipped ${result.skipped}`);
    res.json(result);
  } catch (err) {
    console.error('[Admin] gmail-sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/phone-numbers ─────────────────────────────────────────────
// Lists all phone numbers stored in the DB with their assigned user.

router.get('/phone-numbers', requireOwner, (_req, res) => {
  const numbers = db.prepare(`
    SELECT pn.id, pn.phone_number, pn.friendly_name, pn.twilio_sid,
           pn.assigned_user_id, pn.created_at,
           u.email AS assigned_email, u.display_name AS assigned_display_name
    FROM phone_numbers pn
    LEFT JOIN users u ON u.id = pn.assigned_user_id
    ORDER BY pn.id
  `).all();
  res.json(numbers);
});

// ── GET /api/admin/phone-numbers/search ──────────────────────────────────────
// Searches Twilio for available US local numbers.
// Query param: areaCode (optional)

router.get('/phone-numbers/search', requireOwner, async (req, res) => {
  const { areaCode } = req.query;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  try {
    const client = twilio(accountSid, authToken);
    const params = { limit: 15, voiceEnabled: true, smsEnabled: true };
    if (areaCode) params.areaCode = areaCode;

    const available = await client.availablePhoneNumbers('US').local.list(params);
    res.json(available.map(n => ({
      phoneNumber:  n.phoneNumber,
      friendlyName: n.friendlyName,
      locality:     n.locality,
      region:       n.region,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/phone-numbers/purchase ────────────────────────────────────
// Purchases a Twilio number, sets voice+SMS webhooks, and saves to the DB.
// Body: { phoneNumber: '+1...' }

router.post('/phone-numbers/purchase', requireOwner, express.json(), async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl    = process.env.TWILIO_BASE_URL;

  if (!accountSid || !authToken) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  try {
    const client = twilio(accountSid, authToken);
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber,
      ...(baseUrl && {
        voiceUrl:    `${baseUrl}/api/twilio/voice`,
        voiceMethod: 'POST',
        smsUrl:      `${baseUrl}/api/twilio/sms`,
        smsMethod:   'POST',
      }),
    });

    db.prepare(
      'INSERT INTO phone_numbers (phone_number, twilio_sid, friendly_name) VALUES (?, ?, ?)'
    ).run(purchased.phoneNumber, purchased.sid, purchased.friendlyName);

    const row = db.prepare('SELECT * FROM phone_numbers WHERE twilio_sid = ?').get(purchased.sid);
    console.log(`[Admin] Phone number purchased: ${purchased.phoneNumber} (${purchased.sid})`);
    res.json(row);
  } catch (err) {
    console.error('[Admin] purchase error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/phone-numbers/:id/assign ────────────────────────────────
// Assigns or unassigns a number to a user.
// Body: { userId: number | null }

router.patch('/phone-numbers/:id/assign', requireOwner, express.json(), (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const userId = req.body.userId != null ? parseInt(req.body.userId, 10) : null;

  if (userId !== null) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
  }

  const result = db.prepare(
    'UPDATE phone_numbers SET assigned_user_id = ? WHERE id = ?'
  ).run(userId, id);

  if (result.changes === 0) return res.status(404).json({ error: 'Phone number not found' });

  const row = db.prepare(`
    SELECT pn.id, pn.phone_number, pn.friendly_name, pn.twilio_sid,
           pn.assigned_user_id, pn.created_at,
           u.email AS assigned_email, u.display_name AS assigned_display_name
    FROM phone_numbers pn
    LEFT JOIN users u ON u.id = pn.assigned_user_id
    WHERE pn.id = ?
  `).get(id);
  res.json(row);
});

// ── DELETE /api/admin/phone-numbers/:id ──────────────────────────────────────
// Releases the number from Twilio and removes it from the DB.

router.delete('/phone-numbers/:id', requireOwner, async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM phone_numbers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Phone number not found' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  try {
    if (accountSid && authToken) {
      const client = twilio(accountSid, authToken);
      await client.incomingPhoneNumbers(row.twilio_sid).remove();
    }
    db.prepare('DELETE FROM phone_numbers WHERE id = ?').run(id);
    console.log(`[Admin] Phone number released: ${row.phone_number}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Admin] release error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
