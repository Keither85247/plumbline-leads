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

const { getSessionToken, lookupSession, revokeUserSessions, clearSessionCookieOptions, SUSPENDED_ERROR } = require('../utils/session');

module.exports = function requireAuth(req, res, next) {
  // Cookie, then Bearer (Safari ITP), then ?token= — <audio>/<video> elements
  // make raw resource fetches and cannot send headers, so the frontend appends
  // ?token=<session_token> to recording/voicemail URLs.
  const token = getSessionToken(req, { allowQuery: true });

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Absolute-UTC expiry check (see utils/session.js).
  const session = lookupSession(token);

  if (!session) {
    // Clear the stale cookie so the browser doesn't keep sending it
    res.clearCookie('plumbline_session', clearSessionCookieOptions());
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  // Suspended accounts stop working immediately: end every session and reject.
  // 401 (not 403) so the frontend treats it as a logout.
  if (session.suspended) {
    revokeUserSessions(session.userId);
    res.clearCookie('plumbline_session', clearSessionCookieOptions());
    return res.status(401).json(SUSPENDED_ERROR);
  }

  req.userId = session.userId;
  next();
};
