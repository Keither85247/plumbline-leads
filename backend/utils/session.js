'use strict';
/**
 * Shared session lookup for requireAuth, /auth/me and /auth/logout.
 *
 * Expiry is an absolute UTC instant: sessions.expires_at is written as an ISO
 * string (toISOString(), 'Z'). Comparing it as TEXT against CURRENT_TIMESTAMP
 * ('YYYY-MM-DD HH:MM:SS') let a session live until the end of its expiry day,
 * because 'T' sorts after ' '. julianday() parses both formats as UTC, so the
 * comparison is exact and time-zone / DST independent. Unparseable values give
 * NULL and are rejected (fail closed).
 */

const db = require('../db');

const lookupStmt = db.prepare(`
  SELECT s.user_id      AS userId,
         u.is_suspended AS isSuspended
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token = ?
    AND julianday(s.expires_at) > julianday('now')
`);

/** Token from the session cookie, then Bearer header, then (optionally) ?token=. */
function getSessionToken(req, { allowQuery = false } = {}) {
  let token = req.cookies?.plumbline_session;
  if (!token) {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  }
  if (!token && allowQuery && typeof req.query?.token === 'string') token = req.query.token.trim();
  return typeof token === 'string' && token ? token : null;
}

/**
 * @returns {{ userId: number, suspended: boolean } | null} null when the token
 *   is missing, unknown, expired, or belongs to a deleted user.
 */
function lookupSession(token) {
  if (typeof token !== 'string' || !token || token.length > 256) return null;
  const row = lookupStmt.get(token);
  if (!row) return null;
  return { userId: row.userId, suspended: !!row.isSuspended };
}

/** Ends every session of a suspended account so it stops working immediately. */
function revokeUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function clearSessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return { path: '/', secure: isProd, sameSite: isProd ? 'none' : 'lax' };
}

const SUSPENDED_ERROR = { error: 'This account has been suspended. Contact your administrator.', code: 'ACCOUNT_SUSPENDED' };

module.exports = { getSessionToken, lookupSession, revokeUserSessions, clearSessionCookieOptions, SUSPENDED_ERROR };
