'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const log     = require('../logger').for('Push');
const {
  ENDPOINT_MAX, FCM_TOKEN_MAX,
  validateWebPushEndpoint, validateSubscriptionKeys, validateFcmToken, isDeletableIdentifier,
} = require('../utils/pushValidation');

// Fixed error bodies — never echo the submitted value.
const INVALID_SUB = { error: 'Invalid push subscription' };
const INVALID_FCM = { error: 'Invalid FCM token' };

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
  const ep = validateWebPushEndpoint(endpoint);
  if (!ep.ok) {
    log.warn('Rejected push subscription', { userId: req.userId, reason: ep.reason });
    return res.status(400).json(INVALID_SUB);
  }
  const k = validateSubscriptionKeys(keys?.p256dh, keys?.auth);
  if (!k.ok) {
    log.warn('Rejected push subscription', { userId: req.userId, reason: k.reason });
    return res.status(400).json(INVALID_SUB);
  }

  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh  = excluded.p256dh,
      auth    = excluded.auth
  `).run(req.userId, ep.value, k.value.p256dh, k.value.auth);

  return res.json({ ok: true });
});

// DELETE /api/push/subscribe
// Removes a push subscription (user unsubscribed or revoked permission).
router.delete('/subscribe', express.json(), (req, res) => {
  const { endpoint } = req.body || {};
  if (!isDeletableIdentifier(endpoint, ENDPOINT_MAX)) return res.status(400).json(INVALID_SUB);
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(endpoint, req.userId);
  return res.json({ ok: true });
});

// POST /api/push/fcm-subscribe
// Registers an FCM device token from the Android Capacitor app.
// Called once after the app starts and receives a token from Firebase.
router.post('/fcm-subscribe', express.json(), (req, res) => {
  const { fcmToken } = req.body || {};
  const t = validateFcmToken(fcmToken);
  if (!t.ok) {
    log.warn('Rejected FCM token', { userId: req.userId, reason: t.reason });
    return res.status(400).json(INVALID_FCM);
  }

  db.prepare(`
    INSERT INTO fcm_subscriptions (user_id, fcm_token)
    VALUES (?, ?)
    ON CONFLICT(fcm_token) DO UPDATE SET user_id = excluded.user_id
  `).run(req.userId, t.value);

  return res.json({ ok: true });
});

// DELETE /api/push/fcm-subscribe
// Removes an FCM token (logout or token rotation).
router.delete('/fcm-subscribe', express.json(), (req, res) => {
  const { fcmToken } = req.body || {};
  if (!isDeletableIdentifier(fcmToken, FCM_TOKEN_MAX)) return res.status(400).json(INVALID_FCM);
  db.prepare('DELETE FROM fcm_subscriptions WHERE fcm_token = ? AND user_id = ?')
    .run(fcmToken, req.userId);
  return res.json({ ok: true });
});

module.exports = router;
