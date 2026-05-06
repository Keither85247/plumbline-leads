'use strict';
const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');
const db      = require('../db');
const log     = require('../logger').for('Numbers');

// ── GET /api/numbers/mine ─────────────────────────────────────────────────────
// Returns the phone number assigned to the current user, or null if none.

router.get('/mine', (req, res) => {
  const row = db.prepare(`
    SELECT pn.id, pn.phone_number, pn.friendly_name, pn.twilio_sid
    FROM phone_numbers pn
    WHERE pn.assigned_user_id = ?
    LIMIT 1
  `).get(req.userId);

  return res.json(row || null);
});

// ── GET /api/numbers/search ───────────────────────────────────────────────────
// Searches Twilio for available US local numbers a tester can claim.
// Query param: areaCode (optional)

router.get('/search', async (req, res) => {
  const { areaCode } = req.query;
  const accountSid   = process.env.TWILIO_ACCOUNT_SID;
  const authToken    = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  log.info('Number search', { userId: req.userId, areaCode: areaCode || '(any)' });

  try {
    const client = twilio(accountSid, authToken);
    const params = { limit: 15, voiceEnabled: true, smsEnabled: true };
    if (areaCode) params.areaCode = areaCode;

    const available = await client.availablePhoneNumbers('US').local.list(params);
    log.info('Number search results', { userId: req.userId, count: available.length, areaCode: areaCode || '(any)' });
    return res.json(available.map(n => ({
      phoneNumber:  n.phoneNumber,
      friendlyName: n.friendlyName,
      locality:     n.locality,
      region:       n.region,
    })));
  } catch (err) {
    log.error('Number search failed', { userId: req.userId, err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/numbers/claim ───────────────────────────────────────────────────
// Purchases a Twilio number and assigns it to the current user.
// One-per-user: returns the existing number if one is already assigned.
// Body: { phoneNumber: '+1...' }

router.post('/claim', express.json(), async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });

  // Look up user for log context and suspension check
  const userRow = db.prepare('SELECT email, is_suspended FROM users WHERE id = ?').get(req.userId);
  const userEmail = userRow?.email || '(unknown)';

  log.info('Number claim requested', { userId: req.userId, email: userEmail, phoneNumber });

  // Block suspended users from claiming a number
  if (userRow?.is_suspended) {
    log.warn('Claim blocked — user suspended', { userId: req.userId, email: userEmail });
    return res.status(403).json({ error: 'Your account has been suspended. Contact your administrator.' });
  }

  // One-per-user guardrail: if already assigned, return current number
  const existing = db.prepare(`
    SELECT pn.id, pn.phone_number, pn.friendly_name, pn.twilio_sid
    FROM phone_numbers pn
    WHERE pn.assigned_user_id = ?
    LIMIT 1
  `).get(req.userId);

  if (existing) {
    log.warn('Claim skipped — user already has a number', {
      userId: req.userId, email: userEmail, existingNumber: existing.phone_number,
    });
    return res.json(existing);
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl    = process.env.TWILIO_BASE_URL;

  if (!accountSid || !authToken) {
    log.error('Claim aborted — Twilio credentials not configured', { userId: req.userId });
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  // Log whether webhooks will be set — this tells you if TWILIO_BASE_URL is missing
  if (baseUrl) {
    log.info('Purchasing number with webhooks', {
      userId: req.userId,
      phoneNumber,
      voiceUrl: `${baseUrl}/api/twilio/voice`,
      smsUrl:   `${baseUrl}/api/twilio/sms`,
    });
  } else {
    log.warn('TWILIO_BASE_URL not set — purchasing number WITHOUT webhooks', {
      userId: req.userId, phoneNumber,
    });
  }

  try {
    const client    = twilio(accountSid, authToken);
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber,
      ...(baseUrl && {
        voiceUrl:    `${baseUrl}/api/twilio/voice`,
        voiceMethod: 'POST',
        smsUrl:      `${baseUrl}/api/twilio/sms`,
        smsMethod:   'POST',
      }),
    });

    // Insert and immediately assign to this user
    db.prepare(`
      INSERT INTO phone_numbers (phone_number, twilio_sid, friendly_name, assigned_user_id)
      VALUES (?, ?, ?, ?)
    `).run(purchased.phoneNumber, purchased.sid, purchased.friendlyName, req.userId);

    log.info('Number claimed successfully', {
      userId:    req.userId,
      email:     userEmail,
      number:    purchased.phoneNumber,
      sid:       purchased.sid,
      webhooksSet: !!baseUrl,
    });

    const row = db.prepare('SELECT * FROM phone_numbers WHERE twilio_sid = ?').get(purchased.sid);
    return res.json(row);
  } catch (err) {
    log.error('Number claim failed', { userId: req.userId, email: userEmail, phoneNumber, err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
