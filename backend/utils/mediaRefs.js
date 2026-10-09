'use strict';
/**
 * Owned media references — the ONE place that turns (account, kind, object,
 * part) into something the server may stream.
 *
 * Every lookup is scoped by user_id, and the upstream reference is always
 * derived from the stored row and re-validated (exact Twilio host/path on the
 * configured account, or a confined local file). A client never supplies a URL.
 * Anything not owned, missing, deleted or malformed resolves to null, so
 * callers answer with one generic "not found" that does not reveal whether
 * another account's media exists.
 *
 * Also: response sanitisers. Stored Twilio URLs embed the Account SID, so API
 * responses carry only presence flags / opaque markers, never the URLs.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const db   = require('../db');
const { assertSafeRecordingUrl, assertSafeTwilioMediaUrl } = require('./twilioRecording');

const MMS_TMP_DIR = path.join(os.tmpdir(), 'plumbline-mms');
const KINDS = new Set(['call-recording', 'voicemail', 'mms', 'greeting']);
const MAX_PART = 9;
const LOCAL_MMS_RE = /^\/api\/messages\/media\/(mms-\d{10,16}-[0-9a-f]{8}\.(?:jpg|png|gif|webp))$/;
const GREETING_MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
const MMS_FILE_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

function backendHost() {
  try { return new URL(process.env.TWILIO_BASE_URL).host; } catch { return null; }
}

/** A file strictly inside `dir` (no traversal), or null. */
function confinedFile(dir, name) {
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

/** Classify one stored messages.media_urls element; never trusts the client. */
function mmsElement(raw, part) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return null;
  // 1. Inbound Twilio media URL on the configured account.
  try {
    return { source: 'twilio', url: assertSafeTwilioMediaUrl(raw), label: `attachment-${part + 1}`, op: 'view' };
  } catch { /* not a Twilio media URL */ }
  let u;
  try { u = new URL(raw, 'https://placeholder.invalid'); } catch { return null; }
  // 2. Legacy proxy form (/api/messages/media-proxy?url=…): derive the
  //    underlying Twilio reference and validate it the same strict way.
  if (u.pathname === '/api/messages/media-proxy') {
    const inner = u.searchParams.get('url');
    try {
      return { source: 'twilio', url: assertSafeTwilioMediaUrl(inner), label: `attachment-${part + 1}`, op: 'view' };
    } catch { return null; }
  }
  // 3. Our own outbound upload (/api/messages/media/<generated name>) on this
  //    backend (or stored as a relative path).
  const m = LOCAL_MMS_RE.exec(u.pathname);
  if (m && !u.search && !u.hash && (u.host === 'placeholder.invalid' || u.host === backendHost())) {
    const file = confinedFile(MMS_TMP_DIR, m[1]);
    if (!file) return null;
    return { source: 'file', path: file, contentType: MMS_FILE_MIME[path.extname(m[1])] || 'application/octet-stream', label: `attachment-${part + 1}`, op: 'view' };
  }
  return null;
}

/**
 * @returns {null | { source: 'twilio', url, label, op } | { source: 'file', path, contentType, label, op }}
 */
function resolveOwnedMedia(userId, kind, objectId, part = 0) {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!KINDS.has(kind) || !Number.isInteger(objectId) || objectId <= 0) return null;
  if (!Number.isInteger(part) || part < 0 || part > MAX_PART) return null;

  if (kind === 'call-recording' || kind === 'voicemail') {
    if (part !== 0) return null;
    const row = kind === 'call-recording'
      ? db.prepare('SELECT recording_url FROM calls WHERE id = ? AND user_id = ?').get(objectId, userId)
      : db.prepare('SELECT recording_url FROM leads WHERE id = ? AND user_id = ?').get(objectId, userId);
    if (!row || !row.recording_url) return null;
    try {
      return { source: 'twilio', url: assertSafeRecordingUrl(row.recording_url),
        label: kind === 'voicemail' ? 'voicemail.mp3' : 'recording.mp3', op: 'play' };
    } catch { return null; }
  }

  if (kind === 'mms') {
    const row = db.prepare('SELECT media_urls FROM messages WHERE id = ? AND user_id = ?').get(objectId, userId);
    if (!row || !row.media_urls) return null;
    let list;
    try { list = JSON.parse(row.media_urls); } catch { return null; }
    if (!Array.isArray(list) || part >= list.length) return null;
    return mmsElement(list[part], part);
  }

  // kind === 'greeting': the object is the account itself.
  if (objectId !== userId || part !== 0) return null;
  const g = db.prepare(`
    SELECT audio_file FROM voicemail_greetings
    WHERE user_id = ? AND type = 'audio' AND audio_file IS NOT NULL
  `).get(userId);
  if (!g) return null;
  const { userGreetingDir } = require('../routes/settings');   // lazy: avoids a require cycle
  const file = confinedFile(userGreetingDir(userId), g.audio_file);
  if (!file) return null;
  return { source: 'file', path: file, contentType: GREETING_MIME[path.extname(g.audio_file).toLowerCase()] || 'audio/mpeg',
    label: 'greeting', op: 'play' };
}

/** Does the file behind a 'file' reference still exist? */
function fileExists(ref) {
  try { return fs.statSync(ref.path).isFile(); } catch { return false; }
}

// ── Response sanitisers ───────────────────────────────────────────────────────
const present = (v) => (v === true || (typeof v === 'string' && v.trim() !== '') ? true : null);

/** media_urls JSON → JSON array of opaque markers ("media:0", …), or null. */
function mediaMarkers(json) {
  if (json == null || json === '') return json ?? null;
  let list;
  try { list = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  return JSON.stringify(list.slice(0, MAX_PART + 1).map((_, i) => `media:${i}`));
}

function publicCall(row) {
  if (!row || typeof row !== 'object') return row;
  const o = { ...row };
  if ('recording_url' in o) o.recording_url = present(o.recording_url);
  if ('voicemail_recording_url' in o) o.voicemail_recording_url = present(o.voicemail_recording_url);
  return o;
}

function publicLead(row) {
  if (!row || typeof row !== 'object') return row;
  const o = { ...row };
  if ('recording_url' in o) o.recording_url = present(o.recording_url);
  return o;
}

function publicMessage(row) {
  if (!row || typeof row !== 'object') return row;
  const o = { ...row };
  if ('media_urls' in o) o.media_urls = mediaMarkers(o.media_urls);
  if ('lastMessageMedia' in o) o.lastMessageMedia = mediaMarkers(o.lastMessageMedia);
  return o;
}

module.exports = {
  KINDS, MAX_PART, MMS_TMP_DIR,
  resolveOwnedMedia, fileExists,
  publicCall, publicLead, publicMessage, mediaMarkers,
};
