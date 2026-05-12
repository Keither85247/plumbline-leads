'use strict';
/**
 * GET /api/mms-delivery/:token
 *
 * PUBLIC route — mounted in index.js BEFORE requireAuth so Twilio's servers
 * (which have no plumbline session cookie) can fetch outbound MMS media when
 * delivering a message we sent via the messages.create({mediaUrl}) API.
 *
 * The token is a 32-byte random hex string written into mms_outbound_tokens
 * at send time and bound to a specific filename in MMS_TMP_DIR. Tokens
 * auto-expire after 1 hour — Twilio almost always fetches within seconds,
 * but the retry budget makes the route robust to transient hiccups. Tokens
 * never appear in any messages table column, in API responses to the
 * browser, or in any other user-visible surface — they're for Twilio's
 * eyes only.
 *
 * Security:
 *   • 256 bits of entropy — unguessable in any realistic timeframe
 *   • path.basename on the stored filename blocks any traversal even if a
 *     bad row sneaks in
 *   • the route serves files from MMS_TMP_DIR ONLY, never an arbitrary path
 *   • no listing endpoint — you can only fetch a file by knowing the token
 *
 * The auth-required browser route /api/messages/media/:filename serves the
 * same file but enforces per-user ownership via a SELECT against the
 * messages table. Both routes are needed because Twilio cannot send a
 * session cookie.
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const router  = express.Router();
const db      = require('../db');
const log     = require('../logger').for('MmsDelivery');

// Same directory the outbound-send route writes to. Keeping the path
// duplicated here (rather than imported) so this file is a leaf — Express
// route loading order can't accidentally cause require() cycles.
const MMS_TMP_DIR = path.join(os.tmpdir(), 'plumbline-mms');

const TOKEN_TTL_HOURS = 1;

router.get('/:token', (req, res) => {
  const token = req.params.token;
  // Strict validation: 32-byte hex = 64 chars [a-f0-9]. Reject anything else
  // before touching the DB so we never SELECT with attacker-controlled junk.
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(404).send('Not found');
  }

  const row = db.prepare(`
    SELECT filename FROM mms_outbound_tokens
    WHERE token = ?
      AND created_at > datetime('now', ?)
  `).get(token, `-${TOKEN_TTL_HOURS} hours`);

  if (!row) {
    log.warn('MMS delivery token miss or expired', { tokenPrefix: token.slice(0, 8) });
    return res.status(404).send('Not found');
  }

  // path.basename strips any path components — even if a malformed filename
  // ever landed in the DB, we cannot escape MMS_TMP_DIR.
  const safeName = path.basename(row.filename);
  const filePath = path.join(MMS_TMP_DIR, safeName);
  // Defence in depth: re-resolve and verify the resolved path is inside
  // MMS_TMP_DIR. Belt + suspenders alongside path.basename.
  const resolved = path.resolve(filePath);
  const tmpRoot  = path.resolve(MMS_TMP_DIR);
  if (!resolved.startsWith(tmpRoot + path.sep)) {
    log.error('MMS delivery path escaped MMS_TMP_DIR', { tokenPrefix: token.slice(0, 8), safeName });
    return res.status(404).send('Not found');
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(resolved);
});

module.exports = router;
