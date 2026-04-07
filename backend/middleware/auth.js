'use strict';
/**
 * Simple API-key authentication middleware for tester-phase multi-user support.
 *
 * How it works:
 *   - Each request passes an API key in the `X-API-Key` header
 *   - The key is looked up against the `users` table
 *   - If found, `req.user = { id, email, display_name }` is attached and the
 *     request proceeds; otherwise 401 is returned
 *
 * Setup for testers:
 *   Run the seed script once to create user rows with API keys:
 *     node backend/scripts/seed-users.js
 *   Then give each tester their generated key to use as `X-API-Key: <key>`
 *
 * Migration path (later):
 *   Replace this middleware with JWT validation (e.g. from Clerk or custom).
 *   `req.user.id` is already attached consistently, so data-layer scoping
 *   works without any further changes once auth is swapped.
 *
 * Bypass:
 *   Set SKIP_AUTH=true in .env to disable auth entirely for local dev.
 *   This is automatically true when NODE_ENV is not set (local dev default).
 *   NEVER set this in production.
 */

const db = require('../db');

function requireAuth(req, res, next) {
  // Allow bypass in local development (no NODE_ENV set or explicitly disabled)
  if (process.env.SKIP_AUTH === 'true' || !process.env.NODE_ENV) {
    req.user = null; // no user context; queries return all rows (single-tenant mode)
    return next();
  }

  const key = req.headers['x-api-key'];
  if (!key) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  const user = db.prepare(
    'SELECT id, email, display_name FROM users WHERE api_key = ?'
  ).get(key);

  if (!user) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.user = user;
  next();
}

module.exports = { requireAuth };
