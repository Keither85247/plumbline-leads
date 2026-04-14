'use strict';
/**
 * Session-cookie authentication middleware.
 *
 * Reads the `plumbline_session` httpOnly cookie, looks it up in the sessions
 * table, and sets req.userId to the owning user's integer ID.
 *
 * Returns 401 JSON (never HTML) if the cookie is absent or the session is
 * expired/missing so the frontend can redirect to the login page cleanly.
 */

const db = require('../db');

module.exports = function requireAuth(req, res, next) {
  const token = req.cookies?.plumbline_session;

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
