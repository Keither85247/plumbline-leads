'use strict';
/**
 * Health endpoints.
 *
 * publicRouter — mounted BEFORE requireAuth. Liveness only: Render's health
 *   check (render.yaml healthCheckPath) and the frontend status/warm-up pings
 *   read res.ok, so the body is a fixed { ok: true } with no account data,
 *   configuration, or version details.
 *
 * ownerRouter — mounted AFTER requireAuth, behind requireOwner. Detailed
 *   diagnostics (env flags, owner-account presence) for the owner only.
 */

const express = require('express');
const db      = require('../db');

const publicRouter = express.Router();
publicRouter.get('/', (_req, res) => res.json({ ok: true }));

const ownerRouter = express.Router();

// Env-flag diagnostic — owner only (reveals sign-up / tester-bypass settings).
ownerRouter.get('/env', (_req, res) => {
  res.json({
    ALLOW_PUBLIC_SIGNUP:  process.env.ALLOW_PUBLIC_SIGNUP  || '(not set)',
    ENABLE_TESTER_BYPASS: process.env.ENABLE_TESTER_BYPASS || '(not set)',
    NODE_ENV:             process.env.NODE_ENV             || '(not set)',
  });
});

// Owner-account diagnostic — owner only. Used to verify a RESET_OWNER_PASSWORD
// run on Render.
ownerRouter.get('/owner', (_req, res) => {
  try {
    const owner = db.prepare(
      'SELECT id, email, is_owner, (password_hash IS NOT NULL) AS has_password FROM users WHERE is_owner = 1 LIMIT 1'
    ).get();
    const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({
      owner_exists:  !!owner,
      owner_email:   owner ? owner.email  : null,
      owner_id:      owner ? owner.id     : null,
      has_password:  owner ? !!owner.has_password : false,
      total_users:   total,
    });
  } catch (err) {
    console.error('[Health] owner diagnostic failed:', err.message);
    res.status(500).json({ error: 'Diagnostic failed' });
  }
});

module.exports = { publicRouter, ownerRouter };
