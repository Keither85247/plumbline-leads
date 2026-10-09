'use strict';
/**
 * Media tickets — recordings, voicemails, MMS attachments and the voicemail
 * greeting preview are played/shown without any session credential in a URL.
 *
 *   POST /api/media/tickets   (signed-in app; JSON + allowed Origin)
 *        { items: [{ kind, id, part? }] }  →  { tickets: [ticket | null] }
 *        One ticket per owned media object: 256-bit random, stored only as a
 *        SHA-256 hash, bound to the account, the minting session, one object
 *        (kind + id + part) and one operation, valid 10 minutes, and limited
 *        to a small number of uses (audio seeking issues several range
 *        requests; an image needs one or two).
 *   GET  /api/media/stream?mt=<ticket>   (no session needed — works where the
 *        backend cookie is not sent, e.g. Safari/ITP)
 *        Re-checks everything on every use: ticket unexpired and under its use
 *        limit, account active, minting session still valid, and the object
 *        STILL owned by that account; then derives the upstream reference from
 *        the stored row (utils/mediaRefs.js) and streams it. Twilio media is
 *        fetched through the host-pinned client (utils/safeFetch.js) with the
 *        account credentials sent only to api.twilio.com; Twilio's one CDN
 *        redirect is followed without credentials. Upstream URLs, SIDs and
 *        credentials never reach the client.
 *
 * Every refusal is the same generic 404 (no existence oracle). Nothing here
 * logs tickets, URLs, headers or media.
 */

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const { Transform } = require('stream');
const db      = require('../db');
const { resolveSession } = require('../utils/session');
const { isAccountActive } = require('../utils/accountStatus');
const { requireAppRequest } = require('../utils/appRequest');
const { createLimiter } = require('../utils/rateLimiter');
const { resolveOwnedMedia, fileExists, KINDS, MAX_PART } = require('../utils/mediaRefs');
const { safeGet } = require('../utils/safeFetch');
const { isTwilioApiUrl, isTwilioMediaRedirect } = require('../utils/twilioRecording');
const { registerHousekeeping } = require('../jobs/housekeeping');
const { parseRange, fileRange } = require('../utils/httpRange');

const TICKET_TTL_MS  = 10 * 60 * 1000;
const TICKET_RE      = /^[A-Za-z0-9_-]{43}$/;
const MAX_ITEMS      = 20;
const MAX_LIVE       = 1000;                      // unexpired tickets kept per account (bounds storage)
const MAX_USES       = { play: 200, view: 6 };   // Safari plays audio with many small range requests
const MAX_BYTES      = 50 * 1024 * 1024;
const SAFE_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/ogg', 'audio/amr', 'audio/3gpp',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/3gpp', 'video/quicktime',
]);
const mintLimit = createLimiter({ name: 'media-ticket-mint', windowMs: 10 * 60 * 1000, max: 600 });
// Media requests per account (each Twilio-backed one is a credentialed
// upstream fetch on the shared Twilio account).
const streamLimit = createLimiter({ name: 'media-stream', windowMs: 10 * 60 * 1000, max: 1500 });

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const nowIso = () => new Date().toISOString();
const mediaLog = (event) => console.log(`[Media] ${event}`);

// ── Tickets ───────────────────────────────────────────────────────────────────
const router = express.Router();

router.post('/tickets', requireAppRequest, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
    return res.status(400).json({ error: 'Invalid request', code: 'bad_request' });
  }
  const wait = mintLimit.hit(String(req.userId));
  if (wait) return res.status(429).set('Retry-After', String(wait)).json({ error: 'Too many requests', code: 'too_many_attempts' });

  // Bind tickets to the minting session: signing out ends them. The rowid
  // alone is not enough (SQLite reuses the rowid of a deleted newest row), so
  // the ticket also stores a fingerprint of the session token itself.
  const r = resolveSession(req);
  const sessionId = r.status === 'ok'
    ? db.prepare('SELECT rowid AS rid FROM sessions WHERE token = ?').get(r.token)?.rid
    : null;
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
  const sessionFp = sha256(`session:${r.token}`);

  // Storage bound: drop this account's expired tickets; beyond MAX_LIVE live
  // ones the account's oldest are retired (a player whose ticket was retired
  // simply fetches a new one) — minting is never refused for volume alone.
  const now = nowIso();
  db.prepare('DELETE FROM media_tickets WHERE user_id = ? AND expires_at <= ?').run(req.userId, now);
  const live = db.prepare('SELECT COUNT(*) AS n FROM media_tickets WHERE user_id = ?').get(req.userId).n;
  const excess = live + items.length - MAX_LIVE;
  if (excess > 0) {
    db.prepare(`
      DELETE FROM media_tickets WHERE ticket_hash IN (
        SELECT ticket_hash FROM media_tickets WHERE user_id = ? ORDER BY created_at, rowid LIMIT ?)
    `).run(req.userId, excess);
  }

  const insert = db.prepare(`
    INSERT INTO media_tickets (ticket_hash, user_id, session_id, session_fp, kind, object_id, part, op, max_uses, uses, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const expires = new Date(Date.now() + TICKET_TTL_MS).toISOString();
  const tickets = db.transaction(() => items.map((it) => {
    if (!it || typeof it !== 'object') return null;
    const kind = it.kind;
    // The greeting is the signed-in account's own; the client never names it.
    const id   = kind === 'greeting' ? req.userId : it.id;
    const part = it.part === undefined ? 0 : it.part;
    if (typeof kind !== 'string' || !KINDS.has(kind) || !Number.isInteger(id) || !Number.isInteger(part) || part < 0 || part > MAX_PART) return null;
    const ref = resolveOwnedMedia(req.userId, kind, id, part);       // ownership check #1
    if (!ref || (ref.source === 'file' && !fileExists(ref))) return null;
    const ticket = crypto.randomBytes(32).toString('base64url');
    insert.run(sha256(ticket), req.userId, sessionId, sessionFp, kind, id, part, ref.op, MAX_USES[ref.op], expires, now);
    return ticket;
  }))();
  return res.json({ tickets });
});

// ── Streaming ─────────────────────────────────────────────────────────────────
const publicRouter = express.Router();

function notFound(res) {
  if (!res.headersSent) res.status(404).json({ error: 'Not found' });
}

function mediaHeaders(res, ref, contentType) {
  const type = SAFE_TYPES.has(contentType) ? contentType : 'application/octet-stream';
  res.set('Content-Type', type);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  const ext = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[type] || '';
  const base = String(ref.label || 'media').replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9_-]/g, '') || 'media';
  res.set('Content-Disposition', `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${base}${ext}"`);
}

function byteCap(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) return cb(Object.assign(new Error('too_large'), { code: 'too_large' }));
      cb(null, chunk);
    },
  });
}

function serveFile(req, res, ref) {
  let stat;
  try { stat = fs.statSync(ref.path); } catch { return notFound(res); }
  if (!stat.isFile() || stat.size > MAX_BYTES) return notFound(res);
  const total = stat.size;
  mediaHeaders(res, ref, ref.contentType);
  res.set('Accept-Ranges', 'bytes');
  const r = fileRange(parseRange(req.headers.range), total);
  if (r.unsatisfiable) {
    res.status(416).set('Content-Range', `bytes */${total}`);
    return res.end();
  }
  const { start, end, status } = r;
  if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.status(status).set('Content-Length', String(total === 0 ? 0 : end - start + 1));
  if (total === 0) return res.end();
  const stream = fs.createReadStream(ref.path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function serveTwilio(req, res, ref) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) { mediaLog('upstream not configured'); return res.status(503).json({ error: 'Media unavailable' }); }
  const range = parseRange(req.headers.range);
  const headers = { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` };
  if (range) headers.Range = range.header;

  let upstream;
  try {
    upstream = await safeGet(ref.url, {
      headers,
      isAllowed: isTwilioApiUrl,
      redirect: { max: 1, isAllowed: isTwilioMediaRedirect },
      timeoutMs: 15_000,
    });
  } catch (err) {
    mediaLog(`upstream refused: ${err?.code || 'error'}`);
    return res.status(502).json({ error: 'Media unavailable' });
  }
  const status = upstream.statusCode;
  if (status === 404) { upstream.resume(); return notFound(res); }
  if (status === 416) { upstream.resume(); res.status(416); return res.end(); }
  if (status !== 200 && status !== 206) {
    upstream.resume();
    mediaLog(`upstream status ${status}`);
    return res.status(502).json({ error: 'Media unavailable' });
  }
  const upstreamType = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const type = ref.op === 'play' && upstreamType.startsWith('audio/') && !SAFE_TYPES.has(upstreamType) ? 'audio/mpeg' : upstreamType;
  mediaHeaders(res, ref, type);
  if (ref.op === 'play') res.set('Accept-Ranges', 'bytes');
  const len = upstream.headers['content-length'];
  if (/^\d{1,15}$/.test(String(len || ''))) {
    if (Number(len) > MAX_BYTES) { upstream.destroy(); return res.status(502).json({ error: 'Media unavailable' }); }
    res.set('Content-Length', String(len));
  }
  const cr = upstream.headers['content-range'];
  if (status === 206 && typeof cr === 'string' && /^bytes \d{1,15}-\d{1,15}\/(\d{1,15}|\*)$/.test(cr)) res.set('Content-Range', cr);
  res.status(status);
  const cap = byteCap(MAX_BYTES);
  cap.on('error', () => { upstream.destroy(); res.destroy(); });
  upstream.on('error', () => res.destroy());
  res.on('close', () => upstream.destroy());
  upstream.pipe(cap).pipe(res);
}

publicRouter.get('/stream', async (req, res) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Referrer-Policy', 'no-referrer');
  const t = req.query.mt;
  if (typeof t !== 'string' || !TICKET_RE.test(t)) return notFound(res);

  // Atomic use: unexpired and under its use limit (bounds replay).
  const row = db.prepare(`
    UPDATE media_tickets SET uses = uses + 1
    WHERE ticket_hash = ? AND expires_at > ? AND uses < max_uses
    RETURNING user_id AS userId, session_id AS sessionId, session_fp AS sessionFp, kind, object_id AS objectId, part, op
  `).get(sha256(t), nowIso());
  if (!row) return notFound(res);

  // Everything is re-checked on every use.
  if (!isAccountActive(row.userId)) return notFound(res);
  const session = db.prepare(`
    SELECT token FROM sessions WHERE rowid = ? AND user_id = ? AND julianday(expires_at) > julianday('now')
  `).get(row.sessionId, row.userId);
  if (!session || typeof row.sessionFp !== 'string'
      || !crypto.timingSafeEqual(Buffer.from(sha256(`session:${session.token}`)), Buffer.from(row.sessionFp.padEnd(64).slice(0, 64)))) {
    return notFound(res);
  }
  const ref = resolveOwnedMedia(row.userId, row.kind, row.objectId, row.part);   // ownership check #2
  if (!ref || ref.op !== row.op) return notFound(res);

  const wait = streamLimit.hit(String(row.userId));
  if (wait) return res.status(429).set('Retry-After', String(wait)).json({ error: 'Too many requests' });

  if (ref.source === 'file') {
    if (!fileExists(ref)) return notFound(res);
    return serveFile(req, res, ref);
  }
  return serveTwilio(req, res, ref);
});

/** Remove expired tickets (housekeeping; index on expires_at, ISO text). */
function purgeExpiredTickets() {
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const c = db.prepare(`
      DELETE FROM media_tickets WHERE ticket_hash IN (
        SELECT ticket_hash FROM media_tickets WHERE expires_at <= ? LIMIT 500)
    `).run(nowIso()).changes;
    n += c;
    if (c < 500) break;
  }
  return n;
}
registerHousekeeping('expired media tickets', async () => purgeExpiredTickets());

module.exports = { router, publicRouter, parseRange, purgeExpiredTickets, mintLimit, streamLimit, TICKET_TTL_MS, MAX_USES, MAX_LIVE };
