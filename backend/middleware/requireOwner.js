'use strict';
/**
 * Owner-only guard — must be applied AFTER requireAuth (which sets req.userId).
 *
 * Reads is_owner from the users table and blocks with 403 if the flag is not set.
 * Use this in front of admin-only routes like /api/admin/reset-demo.
 */

const db = require('../db');

module.exports = function requireOwner(req, res, next) {
  const user = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(req.userId);

  if (!user?.is_owner) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
};
