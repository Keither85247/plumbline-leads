'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');
const log     = require('../logger').for('Settings');
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

// ── Per-user voicemail helpers ────────────────────────────────────────────────

function userGreetingDir(userId) {
  return path.join(getDataDir(), 'voicemail_greetings', `user_${userId}`);
}

function getGreetingRow(userId) {
  return db.prepare(`
    SELECT user_id, type, tts_text, audio_file, public_token
    FROM voicemail_greetings
    WHERE user_id = ?
  `).get(userId);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Wipes every audio file in the user's greeting directory. Used before saving
 * a new upload and on explicit delete. Bounded to the user's own dir — never
 * touches another user's storage.
 */
function clearUserAudioFiles(userId) {
  const dir = userGreetingDir(userId);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
}

// ── PATCH /api/settings/profile ──────────────────────────────────────────────
// Updates the current user's display_name and/or business_name.
router.patch('/profile', express.json(), (req, res) => {
  const { display_name, business_name } = req.body || {};

  if (display_name !== undefined) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(String(display_name).trim().slice(0, 100), req.userId);
  }
  if (business_name !== undefined) {
    db.prepare('UPDATE users SET business_name = ? WHERE id = ?')
      .run(String(business_name).trim().slice(0, 200), req.userId);
  }

  const updated = db.prepare(
    'SELECT id, email, display_name, business_name FROM users WHERE id = ?'
  ).get(req.userId);

  return res.json(updated);
});

// ── GET /api/settings ─────────────────────────────────────────────────────────
// Returns ONLY the current user's voicemail greeting state. New users with no
// row see the default TTS string and a null audio file — never another user's data.
router.get('/', (req, res) => {
  const row = getGreetingRow(req.userId);

  if (!row) {
    return res.json({
      voicemail_greeting:      DEFAULT_GREETING,
      voicemail_greeting_type: 'tts',
      voicemail_greeting_file: null,
      voicemail_audio_url:     null,
    });
  }

  const audioReady = row.type === 'audio' && row.audio_file && row.public_token;

  res.json({
    voicemail_greeting:      row.tts_text || DEFAULT_GREETING,
    voicemail_greeting_type: row.type || 'tts',
    voicemail_greeting_file: audioReady ? row.audio_file : null,
    // Tokenised URL the frontend (and Twilio) use to stream the audio.
    // The token is per-user, rotates on every upload, and is the ONLY way
    // to access the file. No userId is exposed in the URL.
    voicemail_audio_url:     audioReady ? `/twilio/voicemail-audio?t=${row.public_token}` : null,
  });
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
// Updates the current user's TTS greeting text only. Switches mode back to TTS.
// Does NOT delete an uploaded audio file — that's the explicit DELETE route's job.
router.put('/', express.json(), (req, res) => {
  const { voicemail_greeting } = req.body || {};
  if (voicemail_greeting === undefined) return res.json({ ok: true });

  const text = String(voicemail_greeting).trim() || DEFAULT_GREETING;
  const row  = getGreetingRow(req.userId);

  if (row) {
    db.prepare(`
      UPDATE voicemail_greetings
      SET tts_text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(text, req.userId);
  } else {
    db.prepare(`
      INSERT INTO voicemail_greetings (user_id, type, tts_text, public_token)
      VALUES (?, 'tts', ?, ?)
    `).run(req.userId, text, generateToken());
  }

  res.json({ ok: true });
});

// ── POST /api/settings/voicemail-greeting ─────────────────────────────────────
// Accepts raw binary audio body (Content-Type: audio/*).
// Stores the file in the user's private directory with a UUID filename and
// rotates the public token so any previously-shared URL stops working.
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

    const userDir  = userGreetingDir(req.userId);
    const uuid     = crypto.randomBytes(16).toString('hex');
    const filename = `greeting_${uuid}${ext}`;
    const filepath = path.join(userDir, filename);

    try {
      fs.mkdirSync(userDir, { recursive: true });
      // Clear any previous upload BEFORE writing the new one so we never
      // leave behind orphan files on this user's filesystem.
      clearUserAudioFiles(req.userId);
      fs.writeFileSync(filepath, buffer);
    } catch (err) {
      log.error('Failed to save voicemail greeting', { userId: req.userId, err: err.message });
      return res.status(500).json({ error: 'Failed to save audio file: ' + err.message });
    }

    const newToken = generateToken();
    const existing = getGreetingRow(req.userId);

    if (existing) {
      db.prepare(`
        UPDATE voicemail_greetings
        SET type = 'audio',
            audio_file = ?,
            public_token = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(filename, newToken, req.userId);
    } else {
      db.prepare(`
        INSERT INTO voicemail_greetings (user_id, type, audio_file, public_token)
        VALUES (?, 'audio', ?, ?)
      `).run(req.userId, filename, newToken);
    }

    log.info('Voicemail greeting uploaded', { userId: req.userId, filename, bytes: buffer.length });

    return res.json({
      ok: true,
      filename,
      voicemail_audio_url: `/twilio/voicemail-audio?t=${newToken}`,
    });
  }
);

// ── DELETE /api/settings/voicemail-greeting ───────────────────────────────────
// Deletes ONLY the current user's audio file and resets them to TTS.
// Cannot affect any other user's greeting under any circumstance.
router.delete('/voicemail-greeting', (req, res) => {
  clearUserAudioFiles(req.userId);

  const existing = getGreetingRow(req.userId);
  if (existing) {
    db.prepare(`
      UPDATE voicemail_greetings
      SET type = 'tts',
          audio_file = NULL,
          public_token = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(generateToken(), req.userId);
  }

  log.info('Voicemail greeting reset to TTS', { userId: req.userId });
  res.json({ ok: true });
});

module.exports = router;
module.exports.DEFAULT_GREETING = DEFAULT_GREETING;
module.exports.userGreetingDir  = userGreetingDir;
module.exports.getGreetingRow   = getGreetingRow;
