'use strict';
/**
 * Admin routes — owner-only operations.
 *
 * All routes here are protected by both requireAuth (set in index.js before
 * the /api/admin mount) and requireOwner (applied per-route here).
 *
 * Routes:
 *   POST /api/admin/reset-demo   — wipe and re-seed the demo user's data
 *   GET  /api/admin/users        — list all user accounts (email, is_owner, created_at)
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../db');
const requireOwner = require('../middleware/requireOwner');
const { seedDemoData } = require('../scripts/seed-demo');

// DEMO_EMAIL identifies the demo account. Set this env var on Render if you
// want to use a different address; defaults match the create-user suggestion.
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@plumblineleads.com';

// ── POST /api/admin/reset-demo ────────────────────────────────────────────────
// Wipes all data rows owned by the demo user and re-seeds with fake demo data.
// Call this before handing a demo login to someone.

router.post('/reset-demo', requireOwner, (req, res) => {
  const demoUser = db.prepare('SELECT id, email FROM users WHERE email = ?').get(DEMO_EMAIL);

  if (!demoUser) {
    return res.status(404).json({
      error: `Demo user not found. Expected email: ${DEMO_EMAIL}. ` +
             'Create the account with: node scripts/create-user.js',
    });
  }

  const uid = demoUser.id;

  // Wipe all demo user's data in a single transaction
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM leads    WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM calls    WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM emails   WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM contacts WHERE user_id = ?').run(uid);
  });

  try {
    wipe();
    seedDemoData(uid);
    console.log(`[Admin] Demo data reset by user ${req.userId} — demo user: ${demoUser.email} (id ${uid})`);
    res.json({ ok: true, demoUserId: uid, demoEmail: demoUser.email });
  } catch (err) {
    console.error('[Admin] reset-demo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
// Returns all user accounts so you can see who exists without touching the DB directly.

router.get('/users', requireOwner, (_req, res) => {
  const users = db.prepare(`
    SELECT id, email, display_name, is_owner, created_at
    FROM users
    ORDER BY id
  `).all();
  res.json(users);
});

module.exports = router;
