'use strict';
/**
 * Shared session lookup for requireAuth, /auth/me, /auth/logout and the Gmail
 * OAuth endpoints.
 *
 * Expiry is an absolute UTC instant: sessions.expires_at is written as an ISO
 * string (toISOString(), 'Z'). Comparing it as TEXT against CURRENT_TIMESTAMP
 * ('YYYY-MM-DD HH:MM:SS') let a session live until the end of its expiry day,
 * because 'T' sorts after ' '. julianday() parses both formats as UTC, so the
 * comparison is exact and time-zone / DST independent. Unparseable values give
 * NULL and are rejected (fail closed). Expired rows are removed by
 * jobs/housekeeping.js, never on the request path.
 */

const db = require('../db');
const { disabledSql, ACCOUNT_DISABLED_ERROR } = require('./accountStatus');

const lookupStmt = db.prepare(`
  SELECT s.user_id AS userId,
         ${disabledSql('u')} AS disabled
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token = ?
    AND julianday(s.expires_at) > julianday('now')
`);

const MAX_TOKEN_LEN = 256;

/** Every credential the request carries, in order: cookie, Bearer, then (optionally) ?token=. */
function sessionCandidates(req, { allowQuery = false } = {}) {
  const out = [];
  const cookie = req.cookies?.plumbline_session;
  if (typeof cookie === 'string' && cookie) out.push({ src: 'cookie', token: cookie });
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim();
    if (bearer) out.push({ src: 'bearer', token: bearer });
  }
  if (allowQuery && typeof req.query?.token === 'string' && req.query.token.trim()) {
    out.push({ src: 'query', token: req.query.token.trim() });
  }
  return out;
}

/** First credential the request carries (cookie, then Bearer, then optional ?token=). */
function getSessionToken(req, opts) {
  return sessionCandidates(req, opts)[0]?.token || null;
}

/**
 * @returns {{ userId: number, disabled: boolean } | null} null when the token
 *   is missing, malformed, unknown, expired, or belongs to a deleted user.
 */
function lookupSession(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LEN) return null;
  const row = lookupStmt.get(token);
  if (!row) return null;
  return { userId: row.userId, disabled: !!row.disabled };
}

/**
 * Resolve the request's session from ALL supplied credentials, so a stale
 * cookie no longer hides a valid Bearer token. Two VALID credentials for
 * different accounts make the request ambiguous, and it is rejected.
 *
 * @returns {{ status: 'none' }                              no credential at all
 *         | { status: 'invalid', staleCookie: boolean }     none of them valid
 *         | { status: 'conflict', staleCookie: boolean }    valid for different accounts
 *         | { status: 'ok', session, token, staleCookie }}  staleCookie: an invalid cookie accompanied a valid credential
 */
function resolveSession(req, opts) {
  const candidates = sessionCandidates(req, opts);
  if (!candidates.length) return { status: 'none' };
  let found = null;
  let staleCookie = false;
  for (const c of candidates) {
    const s = lookupSession(c.token);
    if (!s) { if (c.src === 'cookie') staleCookie = true; continue; }
    if (found && found.session.userId !== s.userId) return { status: 'conflict', staleCookie };
    if (!found) found = { session: s, token: c.token };
  }
  return found ? { status: 'ok', ...found, staleCookie } : { status: 'invalid', staleCookie };
}

/**
 * Ends every session of a disabled account so it stops working immediately.
 * Sessions are EXPIRED (not deleted): the rows stay for the housekeeping grace
 * so the device's own /auth/logout can still attribute and remove its push
 * registration; they can never authenticate again.
 */
function revokeUserSessions(userId) {
  db.prepare(`
    UPDATE sessions SET expires_at = ?
    WHERE user_id = ? AND julianday(expires_at) > julianday('now', '-1 second')
  `).run(new Date(Date.now() - 1000).toISOString(), userId);
}

function clearSessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return { path: '/', secure: isProd, sameSite: isProd ? 'none' : 'lax' };
}

module.exports = {
  sessionCandidates, getSessionToken, lookupSession, resolveSession, revokeUserSessions,
  clearSessionCookieOptions, ACCOUNT_DISABLED_ERROR,
};
