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

const db = require('../db');

module.exports = function requireAuth(req, res, next) {
  let token = req.cookies?.plumbline_session;

  // Safari ITP fallback 1: accept Bearer token from Authorization header
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) token = auth.slice(7).trim();
  }

  // Safari ITP fallback 2: accept token as a URL query param.
  // <audio> / <video> elements make raw resource fetches — they cannot send
  // custom headers, so Bearer-in-header is not available for media proxies.
  // The frontend appends ?token=<session_token> to recording/voicemail URLs.
  if (!token && req.query.token) token = String(req.query.token).trim();

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = db.prepare(`
    SELECT user_id FROM sessions
    WHERE token = ?
      AND expires_at > CURRENT_TIMESTAMP
  `).get(token);

  if (!session) {
    // Clear the stale cookie so the browser doesn't keep sending it
    res.clearCookie('plumbline_session', { path: '/' });
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  req.userId = session.user_id;
  next();
};
