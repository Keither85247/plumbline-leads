'use strict';
/**
 * Guards for state-changing / secret-returning endpoints called by the app.
 *
 * Requiring `Content-Type: application/json` forces a CORS preflight, and the
 * Origin must be one of the app's own origins, so another site cannot trigger
 * these endpoints with the user's cookie (SameSite=None) or read the result.
 */

const CAPACITOR_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

function frontendOrigins() {
  return (process.env.FRONTEND_URL || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function originAllowed(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  if (CAPACITOR_ORIGINS.has(origin)) return true;
  const list = frontendOrigins();
  return list.length ? list.includes(origin) : process.env.NODE_ENV !== 'production';
}

function requireAppRequest(req, res, next) {
  if (!req.is('application/json') || !originAllowed(req.headers.origin)) {
    return res.status(403).json({ error: 'Request not allowed', code: 'bad_request' });
  }
  next();
}

module.exports = { CAPACITOR_ORIGINS, frontendOrigins, originAllowed, requireAppRequest };
