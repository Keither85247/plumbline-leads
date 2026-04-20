'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

const DEFAULT_GREETING =
  "Sorry we missed your call. Please leave a message after the tone and we'll get back to you shortly.";

// GET /api/settings
// Returns current app-wide settings.
router.get('/', (req, res) => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting'").get();
  res.json({
    voicemail_greeting: row?.value ?? DEFAULT_GREETING,
  });
});

// PUT /api/settings
// Upserts one or more setting values. Only known keys are accepted.
router.put('/', express.json(), (req, res) => {
  const { voicemail_greeting } = req.body || {};

  if (voicemail_greeting !== undefined) {
    const text = String(voicemail_greeting).trim();
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('voicemail_greeting', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(text || DEFAULT_GREETING);
  }

  res.json({ ok: true });
});

module.exports = router;
module.exports.DEFAULT_GREETING = DEFAULT_GREETING;
