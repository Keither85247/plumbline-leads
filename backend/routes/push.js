'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/push/vapid-public-key
// Returns the VAPID public key so the frontend can subscribe.
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

// POST /api/push/subscribe
// Saves (or upserts) a push subscription for the current user.
router.post('/subscribe', express.json(), (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint and keys (p256dh, auth) are required' });
  }

  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh  = excluded.p256dh,
      auth    = excluded.auth
  `).run(req.userId, endpoint, keys.p256dh, keys.auth);

  return res.json({ ok: true });
});

// DELETE /api/push/subscribe
// Removes a push subscription (user unsubscribed or revoked permission).
router.delete('/subscribe', express.json(), (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(endpoint, req.userId);
  return res.json({ ok: true });
});

module.exports = router;
