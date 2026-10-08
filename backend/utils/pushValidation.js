'use strict';
/**
 * Validation for push identifiers (pure, no I/O). Every function returns
 * { ok: true, value } or { ok: false, reason } with a FIXED reason code —
 * never the input — so callers can log the reason without echoing user data.
 *
 * Web Push endpoints must be canonical https URLs on a real browser push
 * service, so the server can never be pointed at arbitrary hosts (SSRF):
 *   Chrome/Edge(Chromium)/Opera/Brave/Samsung/Vivaldi → fcm.googleapis.com
 *     (older Chrome: android.googleapis.com; some Chrome builds: jmt17.google.com)
 *   Firefox → updates.push.services.mozilla.com
 *   Safari (macOS 13+, iOS 16.4+) → *.push.apple.com
 *   Edge on Windows (WNS) → *.notify.windows.com
 */

const crypto = require('crypto');

const ENDPOINT_MAX  = 2048;
const FCM_TOKEN_MIN = 32;
const FCM_TOKEN_MAX = 4096;

const EXACT_HOSTS   = new Set(['fcm.googleapis.com', 'android.googleapis.com', 'jmt17.google.com', 'updates.push.services.mozilla.com']);
const SUFFIX_HOSTS  = ['.push.apple.com', '.notify.windows.com'];
const LABEL_RE      = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const fail = (reason) => ({ ok: false, reason });

function hostAllowed(host) {
  if (EXACT_HOSTS.has(host)) return true;
  return SUFFIX_HOSTS.some(sfx => host.endsWith(sfx) && host.length > sfx.length);
}

function validateWebPushEndpoint(s) {
  if (typeof s !== 'string') return fail('type');
  if (s.length < 1 || s.length > ENDPOINT_MAX) return fail('length');
  if (!/^[\x21-\x7E]+$/.test(s)) return fail('charset');
  let u;
  try { u = new URL(s); } catch { return fail('parse'); }
  if (u.href !== s) return fail('non_canonical');
  if (u.protocol !== 'https:') return fail('scheme');
  if (u.username || u.password) return fail('userinfo');
  if (u.port !== '') return fail('port');
  if (u.hash) return fail('fragment');
  const host = u.hostname;
  if (!host.split('.').every(l => LABEL_RE.test(l))) return fail('host_label');
  if (!hostAllowed(host)) return fail('host_not_allowed');
  return { ok: true, value: s };
}

function b64urlExact(str, re, bytes) {
  if (typeof str !== 'string') return null;
  const v = str.replace(/=+$/, '');
  if (!re.test(v)) return null;
  const buf = Buffer.from(v, 'base64url');
  if (buf.length !== bytes || buf.toString('base64url') !== v) return null;
  return { v, buf };
}

function validateSubscriptionKeys(p256dh, auth) {
  const p = b64urlExact(p256dh, /^[A-Za-z0-9_-]{87}$/, 65);
  if (!p || p.buf[0] !== 0x04) return fail('p256dh_format');
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(p.buf);           // throws if the point is not on P-256
  } catch { return fail('p256dh_curve'); }
  const a = b64urlExact(auth, /^[A-Za-z0-9_-]{22}$/, 16);
  if (!a) return fail('auth_format');
  return { ok: true, value: { p256dh: p.v, auth: a.v } };
}

function validateFcmToken(s) {
  if (typeof s !== 'string') return fail('type');
  if (s.length < FCM_TOKEN_MIN || s.length > FCM_TOKEN_MAX) return fail('length');
  if (!/^[A-Za-z0-9_:-]+$/.test(s)) return fail('charset');
  return { ok: true, value: s };
}

/** Delete/logout paths: type + length only, so rows stored before validation can still be removed. */
function isDeletableIdentifier(s, max) {
  return typeof s === 'string' && s.length >= 1 && s.length <= max;
}

module.exports = {
  ENDPOINT_MAX, FCM_TOKEN_MIN, FCM_TOKEN_MAX,
  validateWebPushEndpoint, validateSubscriptionKeys, validateFcmToken, isDeletableIdentifier,
};
