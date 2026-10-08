'use strict';
/**
 * Session-cookie authentication middleware.
 *
 * Primary:  reads the `plumbline_session` httpOnly cookie (Chrome, Firefox).
 * Fallback: reads `Authorization: Bearer <token>` header (Safari — ITP blocks
 *           SameSite=None cookies from third-party domains, so we fall back to
 *           a token stored in localStorage and sent as a header instead).
 *
 * Sets req.userId to the owning user's integer ID.
 * Returns 401 JSON (never HTML) if no valid session is found.
 */

const { resolveSession, revokeUserSessions, clearSessionCookieOptions, ACCOUNT_DISABLED_ERROR } = require('../utils/session');

function authenticate(req, res, next, { allowQuery }) {
  const r = resolveSession(req, { allowQuery });

  if (r.status === 'none') {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (r.status !== 'ok') {
    // Clear the stale cookie so the browser doesn't keep sending it
    res.clearCookie('plumbline_session', clearSessionCookieOptions());
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  if (r.staleCookie) res.clearCookie('plumbline_session', clearSessionCookieOptions());

  // Suspended / blocked accounts stop working on their next request: end every
  // session and reject. 401 (not 403) so the frontend treats it as a sign-out.
  if (r.session.disabled) {
    revokeUserSessions(r.session.userId);
    res.clearCookie('plumbline_session', clearSessionCookieOptions());
    return res.status(401).json(ACCOUNT_DISABLED_ERROR);
  }

  req.userId = r.session.userId;
  next();
}

// Cookie, Bearer (Safari ITP) and ?token= are all considered —
// <audio>/<video> elements make raw resource fetches and cannot send
// headers, so the frontend appends ?token=<session_token> to recording URLs.
function requireAuth(req, res, next) {
  return authenticate(req, res, next, { allowQuery: true });
}

// Cookie or Bearer only — never a session token in a URL. Used by the Gmail
// connection endpoints.
requireAuth.strict = function requireAuthStrict(req, res, next) {
  return authenticate(req, res, next, { allowQuery: false });
};

module.exports = requireAuth;
