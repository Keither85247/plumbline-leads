'use strict';
/**
 * Shared session creation and lookup for login/register, requireAuth,
 * /auth/me, /auth/logout, media tickets and the Gmail OAuth endpoints.
 *
 * Tokens are stored only as utils/sessionToken.storageKey() — never raw. A
 * lookup hashes the presented token and finds the row through the primary-key
 * index on sessions.token, then confirms it with a constant-time comparison.
 *
 * TRANSITION: rows created before hashing hold the raw 64-hex token. Until the
 * one-time revocation retires them, a 64-hex token is matched against raw
 * rows only (never against an 'h1:' hashed row), so no session is locked out
 * by the deploy itself.
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
const { TOKEN_RE, LEGACY_TOKEN_RE, STORAGE_PREFIX, newSessionToken, storageKey, sameKey } = require('./sessionToken');

const SESSION_COLUMNS = `
  SELECT s.rowid   AS sessionId,
         s.token   AS sessionKey,
         s.user_id AS userId,
         ${disabledSql('u')} AS disabled
  FROM sessions s
  JOIN users u ON u.id = s.user_id`;

const lookupStmt = db.prepare(`${SESSION_COLUMNS}
  WHERE s.token = ?
    AND julianday(s.expires_at) > julianday('now')
`);

// Transition only: a pre-hashing raw row. The prefix test keeps a hashed row
// from ever matching here, even if someone presents its stored value.
const legacyLookupStmt = db.prepare(`${SESSION_COLUMNS}
  WHERE s.token = ?
    AND substr(s.token, 1, ${STORAGE_PREFIX.length}) <> '${STORAGE_PREFIX}'
    AND julianday(s.expires_at) > julianday('now')
`);

const insertStmt = db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)');

const MAX_TOKEN_LEN = 256;

/**
 * Every credential the request carries, in order: cookie, then Bearer.
 * A session token in the URL (?token=) is never accepted.
 */
function sessionCandidates(req) {
  const out = [];
  const cookie = req.cookies?.plumbline_session;
  if (typeof cookie === 'string' && cookie) out.push({ src: 'cookie', token: cookie });
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim();
    if (bearer) out.push({ src: 'bearer', token: bearer });
  }
  return out;
}

/**
 * Start a session. Only the storage key is written; the raw token is returned
 * once, for the cookie and the response body, and must not be kept anywhere.
 * @returns {{ token: string, expiresAt: string }}
 */
function createSession(userId, ttlMs) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  insertStmt.run(storageKey(token), userId, expiresAt);
  return { token, expiresAt };
}

/**
 * @returns {{ userId: number, disabled: boolean, sessionId: number, sessionKey: string } | null}
 *   null when the token is missing, malformed, unknown, expired, or belongs to
 *   a deleted user. sessionId/sessionKey identify the stored row (never the
 *   raw token).
 */
function lookupSession(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LEN) return null;
  let row = null;
  if (TOKEN_RE.test(token)) {
    const key = storageKey(token);
    row = lookupStmt.get(key);
    if (row && !sameKey(row.sessionKey, key)) row = null;
  } else if (LEGACY_TOKEN_RE.test(token)) {
    row = legacyLookupStmt.get(token);
  }
  if (!row) return null;
  return { userId: row.userId, disabled: !!row.disabled, sessionId: row.sessionId, sessionKey: row.sessionKey };
}

/**
 * The stored row a presented token refers to, EXPIRED OR NOT — for /auth/logout,
 * which must still find an expired row (housekeeping keeps them for a grace
 * period) to remove this device's push registration. Never authenticates.
 * @returns {{ sessionId: number, sessionKey: string, userId: number } | null}
 */
const findAnyStmt = db.prepare('SELECT rowid AS sessionId, token AS sessionKey, user_id AS userId FROM sessions WHERE token = ?');
const findAnyLegacyStmt = db.prepare(`SELECT rowid AS sessionId, token AS sessionKey, user_id AS userId FROM sessions
  WHERE token = ? AND substr(token, 1, ${STORAGE_PREFIX.length}) <> '${STORAGE_PREFIX}'`);
function findSessionRow(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LEN) return null;
  if (!TOKEN_RE.test(token) && !LEGACY_TOKEN_RE.test(token)) return null;
  return findAnyStmt.get(storageKey(token))
    || (LEGACY_TOKEN_RE.test(token) ? findAnyLegacyStmt.get(token) : null)
    || null;
}

// Row id AND stored key: a rowid can be reused (no AUTOINCREMENT) if another
// process removed this row between the lookup and the delete.
const deleteByIdStmt = db.prepare('DELETE FROM sessions WHERE rowid = ? AND token = ?');
function deleteSessionRow(row) {
  return deleteByIdStmt.run(row.sessionId, row.sessionKey).changes;
}

/**
 * Resolve the request's session from ALL supplied credentials, so a stale
 * cookie no longer hides a valid Bearer token. Two VALID credentials for
 * different accounts make the request ambiguous, and it is rejected.
 *
 * @returns {{ status: 'none' }                              no credential at all
 *         | { status: 'invalid', staleCookie: boolean }     none of them valid
 *         | { status: 'conflict', staleCookie: boolean }    valid for different accounts
 *         | { status: 'ok', session, staleCookie }}         staleCookie: an invalid cookie accompanied a valid credential;
 *                                                           session: see lookupSession (no raw token)
 */
function resolveSession(req) {
  const candidates = sessionCandidates(req);
  if (!candidates.length) return { status: 'none' };
  let found = null;
  let staleCookie = false;
  for (const c of candidates) {
    const s = lookupSession(c.token);
    if (!s) { if (c.src === 'cookie') staleCookie = true; continue; }
    if (found && found.session.userId !== s.userId) return { status: 'conflict', staleCookie };
    if (!found) found = { session: s };
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
  sessionCandidates, createSession, lookupSession, findSessionRow, deleteSessionRow,
  resolveSession, revokeUserSessions, clearSessionCookieOptions, ACCOUNT_DISABLED_ERROR,
};
