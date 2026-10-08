'use strict';
/**
 * Health endpoints.
 *
 * publicRouter — mounted BEFORE requireAuth. Liveness only: Render's health
 *   check (render.yaml healthCheckPath) and the frontend status/warm-up pings
 *   read res.ok, so the body is a fixed { ok: true } with no account data,
 *   configuration, or version details.
 *
 * ownerRouter — mounted AFTER requireAuth, behind requireOwner. Detailed
 *   diagnostics (env flags, owner-account presence) for the owner only.
 */

const express = require('express');
const db      = require('../db');
const { validateWebPushEndpoint, validateSubscriptionKeys, validateFcmToken } = require('../utils/pushValidation');
const { clientIpKey } = require('../utils/clientIp');

const publicRouter = express.Router();
publicRouter.get('/', (_req, res) => res.json({ ok: true }));

const ownerRouter = express.Router();

// Env-flag diagnostic — owner only (reveals sign-up / tester-bypass settings).
ownerRouter.get('/env', (_req, res) => {
  res.json({
    ALLOW_PUBLIC_SIGNUP:  process.env.ALLOW_PUBLIC_SIGNUP  || '(not set)',
    ENABLE_TESTER_BYPASS: process.env.ENABLE_TESTER_BYPASS || '(not set)',
    NODE_ENV:             process.env.NODE_ENV             || '(not set)',
  });
});

// Owner-account diagnostic — owner only. Used to verify a RESET_OWNER_PASSWORD
// run on Render.
ownerRouter.get('/owner', (_req, res) => {
  try {
    const owner = db.prepare(
      'SELECT id, email, is_owner, (password_hash IS NOT NULL) AS has_password FROM users WHERE is_owner = 1 LIMIT 1'
    ).get();
    const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({
      owner_exists:  !!owner,
      owner_email:   owner ? owner.email  : null,
      owner_id:      owner ? owner.id     : null,
      has_password:  owner ? !!owner.has_password : false,
      total_users:   total,
    });
  } catch (err) {
    console.error('[Health] owner diagnostic failed:', err.message);
    res.status(500).json({ error: 'Diagnostic failed' });
  }
});

// Push-registration inventory — owner only, READ-ONLY, counts only. Never
// returns endpoints, tokens, or IP addresses.
ownerRouter.get('/push-inventory', (req, res) => {
  try {
    const n = (sql) => db.prepare(sql).get().n;
    const web = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all();
    const fcm = db.prepare('SELECT fcm_token FROM fcm_subscriptions').all();
    const webReasons = {};
    for (const r of web) {
      const ep = validateWebPushEndpoint(r.endpoint);
      const k  = ep.ok ? validateSubscriptionKeys(r.p256dh, r.auth) : null;
      if (!(ep.ok && k.ok)) { const why = ep.ok ? k.reason : ep.reason; webReasons[why] = (webReasons[why] || 0) + 1; }
    }
    res.json({
      ownerless: {
        push_subscriptions: n('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id IS NULL'),
        fcm_subscriptions:  n('SELECT COUNT(*) AS n FROM fcm_subscriptions WHERE user_id IS NULL'),
      },
      totals: { push_subscriptions: web.length, fcm_subscriptions: fcm.length },
      failingValidation: {
        push_subscriptions: webReasons,
        fcm_subscriptions:  fcm.filter(r => !validateFcmToken(r.fcm_token).ok).length,
      },
      rateLimitIp: {
        cfConnectingIpPresent: typeof req.headers['cf-connecting-ip'] === 'string',
        ipKeyDerived:          clientIpKey(req) !== null,
      },
    });
  } catch (err) {
    console.error('[Health] push inventory failed:', err.message);
    res.status(500).json({ error: 'Diagnostic failed' });
  }
});

module.exports = { publicRouter, ownerRouter };
