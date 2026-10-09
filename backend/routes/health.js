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
const { assertSafeRecordingUrl, assertSafeTwilioMediaUrl } = require('../utils/twilioRecording');
const { getLastHousekeeping, SESSION_GRACE_SECONDS } = require('../jobs/housekeeping');
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
const CRED_RE = /[?&#](token|t|mt|access_token|auth|key|sig|signature|password)=/i;
function classifyUrl(v, validate) {
  if (typeof v !== 'string' || !v.trim()) return 'empty';
  if (CRED_RE.test(v) || /^[a-z]+:\/\/[^/]*@/i.test(v)) return 'credentialBearing';
  try { validate(v); return 'twilio'; } catch { /* not a valid Twilio reference */ }
  if (/\/api\/messages\/media-proxy\?/.test(v)) return 'legacyProxy';
  if (/\/api\/messages\/media\/mms-/.test(v)) return 'localUpload';
  return 'other';
}
function tally(values, validate) {
  const out = { total: 0, twilio: 0, localUpload: 0, legacyProxy: 0, credentialBearing: 0, other: 0 };
  for (const v of values) {
    const c = classifyUrl(v, validate);
    if (c === 'empty') continue;
    out.total++; out[c]++;
  }
  return out;
}
function mediaInventory() {
  const recs = (table) => db.prepare(`SELECT recording_url AS v FROM ${table} WHERE recording_url IS NOT NULL AND recording_url <> ''`).all().map(r => r.v);
  const mmsItems = [];
  let rowsWithMedia = 0, unparseable = 0;
  for (const r of db.prepare("SELECT media_urls AS v FROM messages WHERE media_urls IS NOT NULL AND media_urls <> ''").all()) {
    let list;
    try { list = JSON.parse(r.v); } catch { unparseable++; continue; }
    if (!Array.isArray(list) || !list.length) continue;
    rowsWithMedia++;
    for (const x of list) mmsItems.push(x);
  }
  return {
    callRecordings:     tally(recs('calls'), assertSafeRecordingUrl),
    voicemailRecordings: tally(recs('leads'), assertSafeRecordingUrl),
    mms: { rowsWithMedia, unparseableRows: unparseable, items: tally(mmsItems, assertSafeTwilioMediaUrl) },
    greetingsWithAudio: db.prepare("SELECT COUNT(*) AS n FROM voicemail_greetings WHERE type = 'audio' AND audio_file IS NOT NULL").get().n,
  };
}

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
      // Session housekeeping visibility (counts only; read-only).
      sessions: {
        active:             n("SELECT COUNT(*) AS n FROM sessions WHERE julianday(expires_at) > julianday('now')"),
        expiredWithinGrace: n(`SELECT COUNT(*) AS n FROM sessions WHERE julianday(expires_at) <= julianday('now')
                                 AND julianday(expires_at) > julianday('now', '-${SESSION_GRACE_SECONDS} seconds')`),
        expiredEligible:    n(`SELECT COUNT(*) AS n FROM sessions WHERE julianday(expires_at) <= julianday('now', '-${SESSION_GRACE_SECONDS} seconds')`),
        unparseable:        n('SELECT COUNT(*) AS n FROM sessions WHERE julianday(expires_at) IS NULL'),
      },
      lastHousekeeping: getLastHousekeeping(),
      // Stored media references, classified server-side — COUNTS ONLY, never
      // values. credentialBearing = a query string carrying a token-like
      // parameter or userinfo; nothing is modified.
      media: mediaInventory(),
    });
  } catch (err) {
    console.error('[Health] push inventory failed:', err.message);
    res.status(500).json({ error: 'Diagnostic failed' });
  }
});

module.exports = { publicRouter, ownerRouter };
