'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();
const db      = require('../db');
const { getDataDir } = require('../utils/dataDir');

const DEFAULT_GREETING =
  "Sorry we missed your call. Please leave a message after the tone and we'll get back to you shortly.";

// Supported audio MIME types → file extension mapping.
// Only formats Twilio's <Play> verb can handle.
const ALLOWED_AUDIO_TYPES = {
  'audio/wav':       '.wav',
  'audio/wave':      '.wav',
  'audio/x-wav':     '.wav',
  'audio/mpeg':      '.mp3',
  'audio/mp3':       '.mp3',
  'audio/mp4':       '.m4a',
  'audio/x-m4a':     '.m4a',
  'audio/ogg':       '.ogg',
};

function upsertSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getSetting(key) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
}

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({
    voicemail_greeting:      getSetting('voicemail_greeting')      ?? DEFAULT_GREETING,
    voicemail_greeting_type: getSetting('voicemail_greeting_type') ?? 'tts',
    voicemail_greeting_file: getSetting('voicemail_greeting_file') ?? null,
  });
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
// Updates the TTS greeting text only.
router.put('/', express.json(), (req, res) => {
  const { voicemail_greeting } = req.body || {};
  if (voicemail_greeting !== undefined) {
    const text = String(voicemail_greeting).trim();
    upsertSetting('voicemail_greeting', text || DEFAULT_GREETING);
  }
  res.json({ ok: true });
});

// ── POST /api/settings/voicemail-greeting ─────────────────────────────────────
// Accepts raw binary audio body (Content-Type: audio/*).
// Uses express.raw() per-route — safe because the global express.json()
// middleware ignores non-JSON content types and never consumes this body.
router.post(
  '/voicemail-greeting',
  express.raw({
    type:  (req) => req.headers['content-type']?.startsWith('audio/'),
    limit: '15mb',
  }),
  (req, res) => {
    const mimeType = (req.headers['content-type'] || '').split(';')[0].trim();
    const ext = ALLOWED_AUDIO_TYPES[mimeType];

    if (!ext) {
      return res.status(400).json({
        error: `Unsupported format "${mimeType}". Use wav, mp3, m4a, or ogg.`,
      });
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty or unreadable audio body' });
    }
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large — maximum 10 MB' });
    }

    const dataDir  = getDataDir();
    const filename = `voicemail_greeting${ext}`;
    const filepath = path.join(dataDir, filename);

    // Remove any old greeting files with different extensions
    for (const oldExt of new Set(Object.values(ALLOWED_AUDIO_TYPES))) {
      if (oldExt === ext) continue;
      try { fs.unlinkSync(path.join(dataDir, `voicemail_greeting${oldExt}`)); } catch {}
    }

    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(filepath, buffer);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save audio file: ' + err.message });
    }

    upsertSetting('voicemail_greeting_type', 'audio');
    upsertSetting('voicemail_greeting_file', filename);

    return res.json({ ok: true, filename });
  }
);

// ── DELETE /api/settings/voicemail-greeting ───────────────────────────────────
// Deletes the audio file and resets the greeting to TTS.
router.delete('/voicemail-greeting', (req, res) => {
  const filename = getSetting('voicemail_greeting_file');
  if (filename) {
    try { fs.unlinkSync(path.join(getDataDir(), filename)); } catch {}
  }
  upsertSetting('voicemail_greeting_type', 'tts');
  db.prepare("DELETE FROM app_settings WHERE key = 'voicemail_greeting_file'").run();
  res.json({ ok: true });
});

module.exports = router;
module.exports.DEFAULT_GREETING = DEFAULT_GREETING;
