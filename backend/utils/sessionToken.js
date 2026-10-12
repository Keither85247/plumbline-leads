'use strict';
/**
 * Session token format and at-rest storage form (no dependencies, so db.js
 * migrations can use it too).
 *
 *  • A session token is 'pl1_' + base64url(32 random bytes) — 256 bits of
 *    entropy. It is handed to the client exactly once (the httpOnly cookie and
 *    the login/register response body) and is never stored.
 *  • The database stores only storageKey(token):
 *        'h1:' + hex(SHA-256('plumbline/session-token/v1' || 0x00 || token))
 *    A full-entropy random token needs no salt or slow hash; the domain tag
 *    keeps this hash distinct from every other SHA-256 in the app (OAuth
 *    tickets, media tickets, media-ticket session fingerprints).
 *  • The 'h1:' prefix can never be a valid presented token, so a value read
 *    from a disclosed database (or backup) cannot be replayed as a credential.
 *
 * LEGACY_TOKEN_RE describes tokens issued before hashing (64 lowercase hex).
 * They never authenticate; they are only recognised at logout so a device
 * signed out by the one-time revocation can still find its (hashed, expired)
 * row and remove its own push registration.
 */

const crypto = require('crypto');

const TOKEN_PREFIX    = 'pl1_';
const TOKEN_RE        = /^pl1_[A-Za-z0-9_-]{43}$/;
const LEGACY_TOKEN_RE = /^[0-9a-f]{64}$/;
const STORAGE_PREFIX  = 'h1:';
const STORAGE_KEY_RE  = /^h1:[0-9a-f]{64}$/;
const STORAGE_DOMAIN  = 'plumbline/session-token/v1\0';

/** A fresh session token (raw — return it to the client, never store it). */
function newSessionToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** The only form of a session token that is ever written to the database. */
function storageKey(token) {
  return STORAGE_PREFIX + crypto.createHash('sha256').update(STORAGE_DOMAIN).update(String(token)).digest('hex');
}

/** Constant-time comparison of two storage keys (false — never a throw — for anything malformed). */
function sameKey(a, b) {
  if (!STORAGE_KEY_RE.test(a) || !STORAGE_KEY_RE.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a.slice(3), 'hex'), Buffer.from(b.slice(3), 'hex'));
}

module.exports = {
  TOKEN_RE, LEGACY_TOKEN_RE, STORAGE_PREFIX, STORAGE_KEY_RE,
  newSessionToken, storageKey, sameKey,
};
