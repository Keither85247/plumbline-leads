'use strict';
/**
 * Media credential-exposure tests (RELEASE_READINESS_TEST_REPORT.md DEF-12).
 *
 *   K. Ticket minting: ownership, cross-account / ownerless / bad references,
 *      malformed input, CSRF, auth, rate limit, hashed storage.
 *   S. Streaming: owned recording / voicemail / MMS / greeting, ranges,
 *      expiry, replay limit, malformed tickets, ticket/object mismatch,
 *      deleted media, session + account binding, credentials, upstream errors.
 *   X. SSRF: host allow-lists, redirects (hosts, schemes, ports, userinfo,
 *      encoded and alternate forms, chains), DNS rebinding / private addresses.
 *   R. Responses carry no Twilio URLs, Account SID or durable tokens; ?token=
 *      no longer authenticates anything.
 *   L. Logs / Sentry carry no tickets, URLs or credentials; housekeeping.
 *
 * Hermetic: temp SQLite DB, synthetic accounts, a fake Twilio/CDN behind the
 * stubbed DNS + HTTPS of utils/safeFetch.js — no network, no real media.
 *
 * Run:  node backend/scripts/test-media.js     Exit: 0 = all pass, 1 = any failure.
 */
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const BE  = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `plumbline-media-test-${process.pid}.db`);
const cleanupDb = (p) => { for (const f of [p, `${p}-wal`, `${p}-shm`]) { try { fs.unlinkSync(f); } catch {} } };
cleanupDb(TMP);
process.env.DB_PATH  = TMP;
process.env.DATA_DIR = path.join(os.tmpdir(), `plumbline-media-data-${process.pid}`);

const ACCOUNT_SID = 'AC' + 'a1'.repeat(16);
const OTHER_SID   = 'AC' + 'b2'.repeat(16);
const AUTH_TOKEN  = 'test_twilio_secret_' + crypto.randomBytes(6).toString('hex');
const BASE_URL    = 'https://backend.example.onrender.com';
Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: ACCOUNT_SID, TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_BASE_URL: BASE_URL,
  OPENAI_API_KEY: 'sk-test-not-used', FRONTEND_URL: 'https://app.example.test',
});
delete process.env.NODE_ENV;

const logged = [];
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (process.env.VERBOSE) orig(...a); };
}
const origStdout = process.stdout.write.bind(process.stdout);
const say = (s) => origStdout(s + '\n');

// ── Fake DNS + HTTPS for utils/safeFetch.js (the only outbound media client) ──
const dnsMap = {};                                   // hostname → [{address, family}]
const upstream = { requests: [], routes: [], refuseConnect: false };
const fakeDns = { promises: { lookup: async (host) => {
  if (dnsMap[host]) return dnsMap[host];
  if (host.endsWith('.invalid')) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  if (host.endsWith('.slowdns.test')) return new Promise(() => {});      // never answers
  return [{ address: '52.0.0.10', family: 4 }];
} } };
const fakeHttps = {
  request(opts, cb) {
    const rec = { host: opts.hostname, path: opts.path, headers: { ...(opts.headers || {}) },
      pinned: null, pinnedAll: null, agent: opts.agent };
    opts.lookup && opts.lookup(opts.hostname, {}, (e, a) => { rec.pinned = a; });
    opts.lookup && opts.lookup(opts.hostname, { all: true }, (e, a) => { rec.pinnedAll = a; });
    upstream.requests.push(rec);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      if (upstream.refuseConnect) return req.emit('error', new Error('ECONNREFUSED'));
      const route = upstream.routes.find(r => r.match(rec));
      const res = new PassThrough();
      if (!route) { res.statusCode = 404; res.headers = { 'content-type': 'text/plain' }; cb(res); return res.end('no route'); }
      const out = route.respond(rec);
      if (out.hang) return;                                               // headers never arrive
      res.statusCode = out.status; res.headers = out.headers || {};
      cb(res);
      res.end(out.body || '');
    });
    return req;
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]safeFetch\.js$/.test(parent.filename)) {
    if (request === 'https') return fakeHttps;
    if (request === 'dns') return fakeDns;
  }
  if (request === 'openai') return class OpenAI { constructor() { this.chat = { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } }; this.audio = { transcriptions: { create: async () => ({ text: '' }) } }; } };
  if (request === 'googleapis') return { google: { auth: { OAuth2: function () { return { generateAuthUrl: () => '', on() {} }; } }, gmail: () => ({}), oauth2: () => ({}) } };
  return origLoad.apply(this, arguments);
};

const express      = require(path.join(BE, 'node_modules/express'));
const cookieParser = require(path.join(BE, 'node_modules/cookie-parser'));
const db           = require(path.join(BE, 'db'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); say(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const count = (sql, ...p) => db.prepare(sql).get(...p).n;
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

// ── Fixtures ──────────────────────────────────────────────────────────────────
const mkUser = (email, extra = {}) => Number(db.prepare('INSERT INTO users (email, display_name, is_owner, is_suspended) VALUES (?,?,?,?)')
  .run(email, email, extra.owner ? 1 : 0, extra.suspended ? 1 : 0).lastInsertRowid);
function mkSession(uid, ms = 3600e3) {
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(t, uid, new Date(Date.now() + ms).toISOString());
  return t;
}
const OWNER = mkUser('owner@example.test', { owner: true });
const A = mkUser('a@example.test'), B = mkUser('b@example.test'), D = mkUser('d@example.test');
const hex = (n) => crypto.randomBytes(n).toString('hex');
const RE_A = 'RE' + hex(16), RE_B = 'RE' + hex(16), RE_VA = 'RE' + hex(16);
const recUrl = (re, acct = ACCOUNT_SID) => `https://api.twilio.com/2010-04-01/Accounts/${acct}/Recordings/${re}`;
const MM = 'MM' + hex(16), ME0 = 'ME' + hex(16), ME_B = 'ME' + hex(16);
const mediaUrl = (me, mm = MM, acct = ACCOUNT_SID) => `https://api.twilio.com/2010-04-01/Accounts/${acct}/Messages/${mm}/Media/${me}`;
const insCall = db.prepare('INSERT INTO calls (from_number, call_sid, classification, recording_url, user_id) VALUES (?,?,?,?,?)');
const callA      = Number(insCall.run('+15550000001', 'CA' + hex(16), 'Lead', recUrl(RE_A), A).lastInsertRowid);
const callB      = Number(insCall.run('+15550000002', 'CA' + hex(16), 'Lead', recUrl(RE_B), B).lastInsertRowid);
const callNoRec  = Number(insCall.run('+15550000003', 'CA' + hex(16), 'Lead', null, A).lastInsertRowid);
const callOwnerl = Number(insCall.run('+15550000004', 'CA' + hex(16), 'Lead', recUrl(RE_A), null).lastInsertRowid);
const callEvil   = Number(insCall.run('+15550000005', 'CA' + hex(16), 'Lead', 'https://evil.example/Recordings/x.mp3', A).lastInsertRowid);
const callOther  = Number(insCall.run('+15550000006', 'CA' + hex(16), 'Lead', recUrl(RE_A, OTHER_SID), A).lastInsertRowid);
const callTok    = Number(insCall.run('+15550000007', 'CA' + hex(16), 'Lead', `${BASE_URL}/api/calls/1/recording?token=LEGACYSESSIONSECRET`, A).lastInsertRowid);
const insLead = db.prepare("INSERT INTO leads (contact_name, phone_number, summary, key_points, transcript, source, recording_url, user_id) VALUES (?,?,?,?, 'hello', 'voicemail', ?, ?)");
const vmA = Number(insLead.run('Pat', '+15550000011', 's', '[]', recUrl(RE_VA), A).lastInsertRowid);
const vmB = Number(insLead.run('Lee', '+15550000012', 's', '[]', recUrl(RE_B), B).lastInsertRowid);
const MMS_DIR = path.join(os.tmpdir(), 'plumbline-mms');
fs.mkdirSync(MMS_DIR, { recursive: true });
const localName = `mms-${Date.now()}-${hex(4)}.jpg`;
const localBytes = Buffer.from('0123456789ABCDEFGHIJ');
fs.writeFileSync(path.join(MMS_DIR, localName), localBytes);
const insMsg = db.prepare("INSERT INTO messages (phone, direction, body, status, media_urls, user_id) VALUES (?,?,?,?,?,?)");
const msgA = Number(insMsg.run('+15550000021', 'inbound', '', 'received', JSON.stringify([
  mediaUrl(ME0),                                                           // 0 Twilio media
  `${BASE_URL}/api/messages/media/${localName}`,                           // 1 our outbound upload
  `/api/messages/media-proxy?url=${encodeURIComponent(mediaUrl(ME0))}`,    // 2 legacy proxy form
  'https://evil.example/x.jpg',                                            // 3 foreign host
  'javascript:alert(1)',                                                   // 4 junk
  mediaUrl(ME0, MM, OTHER_SID),                                            // 5 other Twilio account
  `${BASE_URL}/api/messages/media/../../etc/passwd`,                       // 6 traversal
  `/api/messages/media-proxy?url=${encodeURIComponent('https://evil.example/Accounts/x')}`, // 7 legacy form wrapping a foreign URL
]), A).lastInsertRowid);
const msgB = Number(insMsg.run('+15550000022', 'inbound', '', 'received', JSON.stringify([mediaUrl(ME_B)]), B).lastInsertRowid);

// Fake upstream behaviour
const audio = Buffer.from('ID3-fake-audio-payload-0123456789');
const routeRecording = { match: (r) => r.host === 'api.twilio.com' && /\/Recordings\/RE[0-9a-f]{32}\.mp3$/.test(r.path),
  respond: (r) => {
    const rng = /^bytes=(\d+)-(\d+)$/.exec(r.headers.Range || '');
    if (rng) { const s = +rng[1], e = Math.min(+rng[2], audio.length - 1);
      return { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-length': String(e - s + 1), 'content-range': `bytes ${s}-${e}/${audio.length}` }, body: audio.subarray(s, e + 1) }; }
    return { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) }, body: audio };
  } };
let mediaRedirect = 'https://mms.twiliocdn.com/abc/def?Expires=1&Signature=CDNSIG';
const routeMedia = { match: (r) => r.host === 'api.twilio.com' && /\/Media\/ME[0-9a-f]{32}$/.test(r.path),
  respond: () => ({ status: 302, headers: { location: mediaRedirect } }) };
const image = Buffer.from('JPEGDATA');
const routeCdn = { match: (r) => ['mms.twiliocdn.com', 'media.twiliocdn.com', 's3-external-1.amazonaws.com'].includes(r.host),
  respond: () => ({ status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(image.length) }, body: image }) };
upstream.routes.push(routeRecording, routeMedia, routeCdn);

async function run() {
  const media     = require(path.join(BE, 'routes/media'));
  const requireAuth = require(path.join(BE, 'middleware/requireAuth'));
  const requireOwner = require(path.join(BE, 'middleware/requireOwner'));
  const health    = require(path.join(BE, 'routes/health'));
  const calls     = require(path.join(BE, 'routes/calls'));
  const leads     = require(path.join(BE, 'routes/leads'));
  const messages  = require(path.join(BE, 'routes/messages'));
  const settings  = require(path.join(BE, 'routes/settings'));
  const twilioRoutes = require(path.join(BE, 'routes/twilio'));
  const { safeGet, parseAllowed, isPublicAddress } = require(path.join(BE, 'utils/safeFetch'));
  const tr        = require(path.join(BE, 'utils/twilioRecording'));
  const { parseRange, fileRange } = require(path.join(BE, 'utils/httpRange'));
  const hk        = require(path.join(BE, 'jobs/housekeeping'));
  const { sentryPrivacyOptions } = require(path.join(BE, 'utils/sentryScrub'));

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/media', media.publicRouter);
  app.use('/api/twilio', twilioRoutes);
  app.use(requireAuth);
  app.use('/api/calls', calls);
  app.use('/api/leads', leads);
  app.use('/api/messages', messages);
  app.use('/api/settings', settings);
  app.use('/api/media', media.router);
  app.use('/api/health', requireOwner, health.ownerRouter);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ORIGIN = 'https://app.example.test';

  async function req(method, p, { token, json, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (raw !== undefined) body = raw;
    const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString()); } catch {}
    return { status: r.status, buf, text: buf.toString(), data, headers: r.headers };
  }
  const mint = (token, items, { origin = ORIGIN, headers = {} } = {}) =>
    req('POST', '/api/media/tickets', { token, json: { items }, headers: { Origin: origin, ...headers } });
  const stream = (ticket, headers = {}) => req('GET', `/api/media/stream?mt=${encodeURIComponent(ticket)}`, { headers });
  const resetUp = () => { upstream.requests.length = 0; };
  const authTo = (host) => upstream.requests.filter(q => q.host === host && (q.headers.Authorization || q.headers.authorization));
  const tA = mkSession(A), tB = mkSession(B), tO = mkSession(OWNER);
  const secrets = [AUTH_TOKEN, Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64'), 'CDNSIG', 'LEGACYSESSIONSECRET'];
  const seenTickets = [];

  try {
    // ── K. Minting ────────────────────────────────────────────────────────────
    let r = await mint(tA, [{ kind: 'call-recording', id: callA }]);
    const tk1 = r.data?.tickets?.[0];
    seenTickets.push(tk1);
    const row1 = tk1 && db.prepare('SELECT * FROM media_tickets WHERE ticket_hash = ?').get(sha(tk1));
    ok('K1 owned recording → one 256-bit ticket; only its hash is stored, bound to account, session, object, op, ~10 min, use limit',
      r.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(tk1 || '') && row1 && row1.user_id === A && row1.kind === 'call-recording'
      && row1.object_id === callA && row1.op === 'play' && row1.max_uses === 200 && !JSON.stringify(row1).includes(tk1)
      && Math.abs(Date.parse(row1.expires_at) - Date.now() - 600e3) < 15e3 && row1.session_id > 0);
    ok('K2 ticket responses are no-store / no-referrer and contain no URL or SID', /no-store/.test(r.headers.get('cache-control') || '')
      && r.headers.get('referrer-policy') === 'no-referrer' && !/twilio|AC[0-9a-f]{32}|https?:/.test(r.text));
    r = await mint(tA, [
      { kind: 'call-recording', id: callB }, { kind: 'voicemail', id: vmB }, { kind: 'mms', id: msgB, part: 0 },
      { kind: 'call-recording', id: 999999 }, { kind: 'call-recording', id: callOwnerl }, { kind: 'call-recording', id: callNoRec },
    ]);
    ok('K3 another account\'s recording / voicemail / MMS, a nonexistent id, an ownerless row and a row without media all give the same null (no existence oracle)',
      r.status === 200 && r.data.tickets.length === 6 && r.data.tickets.every(x => x === null));
    r = await mint(tA, [{ kind: 'call-recording', id: callEvil }, { kind: 'call-recording', id: callOther }, { kind: 'call-recording', id: callTok }]);
    ok('K4 stored references on a foreign host, another Twilio account, or a legacy ?token= URL are refused', r.data.tickets.every(x => x === null));
    r = await mint(tA, [0, 1, 2, 3, 4, 5, 6, 7, 8].map(part => ({ kind: 'mms', id: msgA, part })));
    const mmsT = r.data.tickets;
    ok('K5 MMS parts: Twilio media, own upload and legacy proxy form are allowed; foreign host, junk, other account, traversal, a legacy form wrapping a foreign URL and out-of-range are refused',
      typeof mmsT[0] === 'string' && typeof mmsT[1] === 'string' && typeof mmsT[2] === 'string'
      && mmsT.slice(3).every(x => x === null));
    const before = count('SELECT COUNT(*) n FROM media_tickets');
    const bad = await Promise.all([
      mint(tA, 'not-an-array'), mint(tA, []), mint(tA, new Array(21).fill({ kind: 'call-recording', id: callA })),
    ]);
    r = await mint(tA, [{ kind: 'nope', id: callA }, { kind: 'call-recording', id: String(callA) }, { kind: 'call-recording', id: -1 },
      { kind: 'mms', id: msgA, part: 99 }, { kind: 'mms', id: msgA, part: '0' }, null, 'x', { kind: 'call-recording', id: 1.5 }]);
    ok('K6 malformed requests: 400 for a bad list; per-item nulls for bad kinds / ids / parts; nothing stored for them',
      bad.every(x => x.status === 400) && r.data.tickets.every(x => x === null) && count('SELECT COUNT(*) n FROM media_tickets') === before);
    const csrf = await req('POST', '/api/media/tickets', { token: tA, raw: JSON.stringify({ items: [{ kind: 'call-recording', id: callA }] }), headers: { 'Content-Type': 'text/plain', Origin: ORIGIN } });
    const foreign = await mint(tA, [{ kind: 'call-recording', id: callA }], { origin: 'https://evil.example' });
    const noOrigin = await req('POST', '/api/media/tickets', { token: tA, json: { items: [{ kind: 'call-recording', id: callA }] } });
    const anon = await req('POST', '/api/media/tickets', { json: { items: [{ kind: 'call-recording', id: callA }] }, headers: { Origin: ORIGIN } });
    const viaQuery = await req('POST', `/api/media/tickets?token=${tA}`, { json: { items: [{ kind: 'call-recording', id: callA }] }, headers: { Origin: ORIGIN } });
    ok('K7 minting needs JSON + an app Origin (CSRF) and a cookie/Bearer session — never ?token=',
      csrf.status === 403 && foreign.status === 403 && noOrigin.status === 403 && anon.status === 401 && viaQuery.status === 401);
    for (let i = 0; i < 600; i++) media.mintLimit.hit(String(B));
    r = await mint(tB, [{ kind: 'call-recording', id: callB }]);
    ok('K8 minting is rate-limited per account', r.status === 429);
    media.mintLimit.clear();
    const E = mkUser('e@example.test');
    const tEE = mkSession(E);
    const callE = Number(insCall.run('+15550000009', 'CA' + hex(16), 'Lead', recUrl(RE_A), E).lastInsertRowid);
    const batch = Array.from({ length: 20 }, () => ({ kind: 'call-recording', id: callE }));
    const capStatus = [];
    const capTickets = [];
    for (let i = 0; i <= media.MAX_LIVE / 20; i++) {
      const rr = await mint(tEE, batch);
      capStatus.push(rr.status);
      capTickets.push(...(rr.data?.tickets || []));
    }
    const liveE = count('SELECT COUNT(*) AS n FROM media_tickets WHERE user_id = ?', E);
    const oldest = (await stream(capTickets[0])).status;
    const newest = (await stream(capTickets.at(-1))).status;
    db.prepare('UPDATE media_tickets SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), E);
    const afterExpire = await mint(tEE, batch);
    const liveE2 = count('SELECT COUNT(*) AS n FROM media_tickets WHERE user_id = ?', E);
    ok('K9 storage is bounded per account: never more than MAX_LIVE unexpired tickets (the oldest are retired, minting is not refused); expired ones are removed at the next mint',
      capStatus.every(x => x === 200) && liveE === media.MAX_LIVE && oldest === 404 && newest === 200 && afterExpire.status === 200 && liveE2 === 20,
      JSON.stringify({ statuses: [...new Set(capStatus)], liveE, oldest, newest, liveE2 }));

    // ── S. Streaming ──────────────────────────────────────────────────────────
    resetUp();
    r = await stream(tk1);
    ok('S1 owned recording streams (200 audio/mpeg) with the exact bytes', r.status === 200 && r.headers.get('content-type') === 'audio/mpeg' && r.buf.equals(audio));
    ok('S2 media responses: private no-store, nosniff, no-referrer, sandbox CSP, inline generic filename, ranges supported',
      /no-store/.test(r.headers.get('cache-control') || '') && r.headers.get('x-content-type-options') === 'nosniff'
      && r.headers.get('referrer-policy') === 'no-referrer' && /sandbox/.test(r.headers.get('content-security-policy') || '')
      && r.headers.get('content-disposition') === 'inline; filename="recording.mp3"' && r.headers.get('accept-ranges') === 'bytes');
    ok('S3 Twilio credentials go only to api.twilio.com, over a connection pinned to the vetted address; nothing upstream leaks into the response',
      upstream.requests.length === 1 && authTo('api.twilio.com').length === 1 && upstream.requests[0].pinned === '52.0.0.10'
      && !/twilio|AC[0-9a-f]{32}|Recordings|RE[0-9a-f]{32}/i.test([...r.headers.entries()].join(' ') + r.text));
    resetUp();
    r = await stream(tk1, { Range: 'bytes=2-5' });
    ok('S4 seeking: a single byte range is forwarded and answered 206 with Content-Range', r.status === 206 && r.headers.get('content-range') === `bytes 2-5/${audio.length}`
      && r.buf.equals(audio.subarray(2, 6)) && upstream.requests[0].headers.Range === 'bytes=2-5');
    resetUp();
    await stream(tk1, { Range: 'bytes=0-1,4-5' }); await stream(tk1, { Range: 'items=0-3' }); await stream(tk1, { Range: 'bytes=9-2' }); await stream(tk1, { Range: 'bytes=' + '9'.repeat(70) });
    ok('S5 malformed / multi / reversed / oversized ranges are dropped (whole body, no odd Range upstream)', upstream.requests.every(q => !q.headers.Range));
    r = await mint(tA, [{ kind: 'voicemail', id: vmA }]);
    const vmTicket = r.data.tickets[0];
    r = await stream(vmTicket);
    ok('S6 owned voicemail streams', r.status === 200 && r.buf.equals(audio) && r.headers.get('content-disposition') === 'inline; filename="voicemail.mp3"');
    resetUp();
    r = await stream(mmsT[0]);
    const cdnReq = upstream.requests.find(q => q.host === 'mms.twiliocdn.com');
    ok('S7 inbound MMS: Twilio\'s redirect to its CDN is followed once WITHOUT credentials; the image is served inline',
      r.status === 200 && r.buf.equals(image) && r.headers.get('content-type') === 'image/jpeg' && authTo('api.twilio.com').length === 1
      && cdnReq && !cdnReq.headers.Authorization && !cdnReq.headers.authorization && r.headers.get('content-disposition') === 'inline; filename="attachment-1.jpg"');
    r = await stream(mmsT[1]);
    const rPart = await stream(mmsT[1], { Range: 'bytes=5-9' });
    const r416 = await stream(mmsT[1], { Range: 'bytes=500-600' });
    ok('S8 own outbound upload served from disk (confined), with ranges and 416 for an unsatisfiable range',
      r.status === 200 && r.buf.equals(localBytes) && rPart.status === 206 && rPart.text === '56789' && rPart.headers.get('content-range') === `bytes 5-9/${localBytes.length}`
      && r416.status === 416 && r416.headers.get('content-range') === `bytes */${localBytes.length}`);
    resetUp();
    r = await stream(mmsT[2]);
    ok('S9 legacy proxy-form references are resolved server-side to the validated Twilio media URL', r.status === 200 && r.buf.equals(image) && upstream.requests[0].host === 'api.twilio.com');
    // Greeting
    const gDir = settings.userGreetingDir(A);
    fs.mkdirSync(gDir, { recursive: true });
    fs.writeFileSync(path.join(gDir, 'greet.mp3'), audio);
    db.prepare("INSERT INTO voicemail_greetings (user_id, type, audio_file, public_token) VALUES (?, 'audio', 'greet.mp3', ?)").run(A, hex(32));
    r = await mint(tA, [{ kind: 'greeting', id: B }]);
    const gT = r.data.tickets[0];
    r = await stream(gT);
    ok('S10 greeting preview: the ticket is always for the signed-in account\'s own greeting (a supplied id is ignored)', r.status === 200 && r.buf.equals(audio));
    const gB = await mint(tB, [{ kind: 'greeting' }]);
    ok('S11 an account without a greeting gets no ticket', gB.data.tickets[0] === null);
    const settingsRes = await req('GET', '/api/settings', { token: tA });
    ok('S12 settings no longer expose the durable greeting token or URL', settingsRes.data?.voicemail_audio_ready === true && !('voicemail_audio_url' in settingsRes.data)
      && !settingsRes.text.includes(db.prepare('SELECT public_token t FROM voicemail_greetings WHERE user_id = ?').get(A).t));

    // Expiry, replay, malformed
    r = await mint(tA, [{ kind: 'call-recording', id: callA }]);
    const tkExp = r.data.tickets[0];
    db.prepare('UPDATE media_tickets SET expires_at = ? WHERE ticket_hash = ?').run(new Date(Date.now() - 1000).toISOString(), sha(tkExp));
    ok('S13 an expired ticket → generic 404', (await stream(tkExp)).status === 404);
    r = await mint(tA, [{ kind: 'mms', id: msgA, part: 1 }]);
    const tkImg = r.data.tickets[0];
    const uses = [];
    for (let i = 0; i < 7; i++) uses.push((await stream(tkImg)).status);
    ok('S14 replay is bounded: an image ticket works 6 times, then 404', uses.slice(0, 6).every(s => s === 200) && uses[6] === 404, uses.join(','));
    const malformed = await Promise.all(['', 'short', 'x'.repeat(43) + '!', 'A'.repeat(44), 'A'.repeat(5000), crypto.randomBytes(32).toString('base64url')].map(t => stream(t)));
    const noParam = await req('GET', '/api/media/stream');
    ok('S15 missing, malformed, oversized and unknown tickets → the same generic 404', malformed.every(x => x.status === 404 && x.text === '{"error":"Not found"}') && noParam.status === 404);

    // Ticket/object binding
    r = await mint(tA, [{ kind: 'call-recording', id: callA }, { kind: 'voicemail', id: vmA }, { kind: 'mms', id: msgA, part: 0 }]);
    const [tMove, tDelVm, tDelMsg] = r.data.tickets;
    db.prepare('UPDATE calls SET user_id = ? WHERE id = ?').run(B, callA);
    const moved = await stream(tMove);
    db.prepare('UPDATE calls SET user_id = ? WHERE id = ?').run(A, callA);
    db.prepare('UPDATE leads SET recording_url = NULL WHERE id = ?').run(vmA);
    const cleared = await stream(tDelVm);
    db.prepare('UPDATE leads SET recording_url = ? WHERE id = ?').run(recUrl(RE_VA), vmA);
    const savedMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgA);
    db.prepare('DELETE FROM messages WHERE id = ?').run(msgA);
    const deleted = await stream(tDelMsg);
    db.prepare('INSERT INTO messages (id, phone, direction, body, status, media_urls, user_id) VALUES (?,?,?,?,?,?,?)')
      .run(savedMsg.id, savedMsg.phone, savedMsg.direction, savedMsg.body, savedMsg.status, savedMsg.media_urls, savedMsg.user_id);
    ok('S16 ownership is re-checked on every use: media moved to another account, cleared or deleted after minting → 404',
      moved.status === 404 && cleared.status === 404 && deleted.status === 404);
    r = await mint(tA, [{ kind: 'mms', id: msgA, part: 1 }]);
    const tGone = r.data.tickets[0];
    fs.renameSync(path.join(MMS_DIR, localName), path.join(MMS_DIR, localName + '.bak'));
    const goneFile = await stream(tGone);
    const goneMint = await mint(tA, [{ kind: 'mms', id: msgA, part: 1 }]);
    fs.renameSync(path.join(MMS_DIR, localName + '.bak'), path.join(MMS_DIR, localName));
    ok('S17 a deleted upload → 404, and no ticket is minted for it', goneFile.status === 404 && goneMint.data.tickets[0] === null);

    // Session + account binding
    const tL = mkSession(A);
    r = await mint(tL, [{ kind: 'call-recording', id: callA }]);
    const tkL = r.data.tickets[0];
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tL);
    const afterLogout = await stream(tkL);
    const tE = mkSession(A);
    r = await mint(tE, [{ kind: 'call-recording', id: callA }]);
    const tkE = r.data.tickets[0];
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), tE);
    const afterExpiry = await stream(tkE);
    const tD = mkSession(D);
    const callD = Number(insCall.run('+15550000008', 'CA' + hex(16), 'Lead', recUrl(RE_A), D).lastInsertRowid);
    r = await mint(tD, [{ kind: 'call-recording', id: callD }]);
    const tkD = r.data.tickets[0];
    db.prepare('UPDATE users SET is_suspended = 1 WHERE id = ?').run(D);
    const afterSuspend = await stream(tkD);
    ok('S18 tickets die with their sign-in: logout, session expiry, or the account being suspended → 404',
      afterLogout.status === 404 && afterExpiry.status === 404 && afterSuspend.status === 404);
    // SQLite gives the next row the rowid of a deleted newest row: a sign-out
    // followed by a new sign-in of the same account must not revive a ticket.
    const tR1 = mkSession(A);
    const rid = (tok) => db.prepare('SELECT rowid AS r FROM sessions WHERE token = ?').get(tok).r;
    const rid1 = rid(tR1);
    const tkR = (await mint(tR1, [{ kind: 'call-recording', id: callA }])).data.tickets[0];
    const beforeOut = (await stream(tkR)).status;
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tR1);
    const tR2 = mkSession(A);
    const rid2 = rid(tR2);
    const reused = (await stream(tkR)).status;
    const freshR = (await stream((await mint(tR2, [{ kind: 'call-recording', id: callA }])).data.tickets[0])).status;
    ok('S22 a ticket stays dead after sign-out even when the next sign-in of the same account reuses the session rowid',
      beforeOut === 200 && rid1 === rid2 && reused === 404 && freshR === 200, JSON.stringify({ beforeOut, rid1, rid2, reused, freshR }));
    for (let i = 0; i < 1500; i++) media.streamLimit.hit(String(A));
    const limited = await stream((await mint(tA, [{ kind: 'call-recording', id: callA }])).data.tickets[0]);
    media.streamLimit.clear();
    // Twilio's <Play> greeting route (public token): bounded ranges, and an
    // aborted download releases its file descriptor.
    const F = mkUser('f@example.test');
    const fDir = settings.userGreetingDir(F);
    fs.mkdirSync(fDir, { recursive: true });
    const big = crypto.randomBytes(4 * 1024 * 1024);
    fs.writeFileSync(path.join(fDir, 'big.mp3'), big);
    const gTok = hex(32);
    db.prepare("INSERT INTO voicemail_greetings (user_id, type, audio_file, public_token) VALUES (?, 'audio', 'big.mp3', ?)").run(F, gTok);
    const gUrl = `/api/twilio/voicemail-audio?t=${gTok}`;
    const g206 = await req('GET', gUrl, { headers: { Range: 'bytes=10-19' } });
    const g416 = await req('GET', gUrl, { headers: { Range: `bytes=${big.length}-` } });
    const gBad = await req('GET', gUrl, { headers: { Range: 'bytes=5-1,7-9' } });
    const g404 = await req('GET', `/api/twilio/voicemail-audio?t=${hex(32)}`);
    const fdCount = () => fs.readdirSync('/dev/fd').length;
    const fd0 = fdCount();
    for (let i = 0; i < 15; i++) {
      const ac = new AbortController();
      const resp = await fetch(base + gUrl, { signal: ac.signal });
      const rd = resp.body.getReader();
      await rd.read();
      ac.abort();
      await rd.cancel().catch(() => {});
    }
    await new Promise(r => setTimeout(r, 300));
    const fdLeak = fdCount() - fd0;
    ok('S24 greeting route (Twilio <Play>): single bounded ranges, 416 when unsatisfiable, malformed ranges → whole file, unknown token → 404',
      g206.status === 206 && g206.buf.equals(big.subarray(10, 20)) && g206.headers.get('content-range') === `bytes 10-19/${big.length}`
      && g416.status === 416 && gBad.status === 200 && gBad.buf.length === big.length && g404.status === 404);
    ok('S25 an aborted greeting download releases its file descriptor (15 aborted downloads)', fdLeak < 5, `fd delta ${fdLeak}`);
    ok('S23 media requests are rate-limited per account (each Twilio-backed one is a credentialed fetch on the shared Twilio account)',
      limited.status === 429 && !/twilio|AC[0-9a-f]{32}/i.test(limited.text));

    // Credentials + upstream failures
    r = await mint(tA, [{ kind: 'call-recording', id: callA }]);
    const tkC = r.data.tickets[0];
    const savedTok = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_AUTH_TOKEN;
    resetUp();
    const noCreds = await stream(tkC);
    process.env.TWILIO_AUTH_TOKEN = savedTok;
    ok('S19 missing Twilio credentials → generic 503, no upstream request', noCreds.status === 503 && upstream.requests.length === 0 && noCreds.text === '{"error":"Media unavailable"}');
    const swap = (respond) => { const orig = routeRecording.respond; routeRecording.respond = respond; return () => { routeRecording.respond = orig; }; };
    let undo = swap(() => ({ status: 401, headers: { 'content-type': 'application/json' }, body: `{"message":"Authenticate","account":"${ACCOUNT_SID}"}` }));
    const badCreds = await stream(tkC); undo();
    undo = swap(() => ({ status: 404, headers: {}, body: 'gone' }));
    const up404 = await stream(tkC); undo();
    undo = swap(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<script>alert(1)</script>' }));
    const html = await stream(tkC); undo();
    undo = swap(() => ({ status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(60 * 1024 * 1024) }, body: 'x' }));
    const huge = await stream(tkC); undo();
    upstream.refuseConnect = true;
    const down = await stream(tkC);
    upstream.refuseConnect = false;
    ok('S20 rejected credentials / upstream errors → generic 502 or 404, never the upstream body or Account SID',
      badCreds.status === 502 && !badCreds.text.includes(ACCOUNT_SID) && up404.status === 404 && down.status === 502);
    ok('S21 unexpected upstream types are never rendered (octet-stream attachment, nosniff, sandbox); oversized media refused',
      html.headers.get('content-type') === 'application/octet-stream' && /^attachment/.test(html.headers.get('content-disposition') || '') && huge.status === 502);

    // ── X. SSRF ───────────────────────────────────────────────────────────────
    const redirects = [
      'https://evil.example/x', 'http://mms.twiliocdn.com/x', 'https://mms.twiliocdn.com:8443/x', 'https://user:pass@mms.twiliocdn.com/x',
      'https://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://2130706433/x', 'https://0x7f.0.0.1/x',
      'https://mms.twiliocdn.com.evil.example/x', 'https://evilmms.twiliocdn.com.evil.example/x', 'https://s3-external-1.amazonaws.com/attacker-bucket/x',
      'https://s3-external-1.amazonaws.com/media.twiliocdn.com.evil/x', '//evil.example/x', 'https://%6d%6d%73.twiliocdn.com.evil.example/x',
      'https://api.twilio.com/2010-04-01/Accounts', 'file:///etc/passwd', 'javascript:alert(1)', 'https://mms.twiliocdn.com\\@evil.example/x'.replace('mms.twiliocdn.com\\@', 'evil.example\\@'),
    ];
    const ssrf = [];
    for (const loc of redirects) {
      mediaRedirect = loc;
      const t = (await mint(tA, [{ kind: 'mms', id: msgA, part: 0 }])).data.tickets[0];
      resetUp();
      const res = await stream(t);
      ssrf.push({ loc, status: res.status, extra: upstream.requests.filter(q => q.host !== 'api.twilio.com').map(q => q.host) });
    }
    mediaRedirect = 'https://mms.twiliocdn.com/abc/def?Expires=1&Signature=CDNSIG';
    ok('X1 redirects to any non-Twilio-CDN target (other hosts, http, ports, userinfo, IP literals incl. decimal/hex, look-alikes, encoded, other buckets, other schemes) are refused before any request',
      ssrf.every(x => x.status === 502 && x.extra.length === 0), JSON.stringify(ssrf.filter(x => !(x.status === 502 && x.extra.length === 0))).slice(0, 300));
    for (const ok2 of ['https://media.twiliocdn.com/x', 'https://s3-external-1.amazonaws.com/media.twiliocdn.com/AC/x', 'https://MMS.TWILIOCDN.COM/x']) {
      mediaRedirect = ok2;
      const t = (await mint(tA, [{ kind: 'mms', id: msgA, part: 0 }])).data.tickets[0];
      resetUp();
      const res = await stream(t);
      ssrf.push({ allowed: ok2, status: res.status, auth: upstream.requests.filter(q => q.host !== 'api.twilio.com').some(q => q.headers.Authorization) });
    }
    mediaRedirect = 'https://mms.twiliocdn.com/abc/def?Expires=1&Signature=CDNSIG';
    ok('X2 Twilio\'s documented CDN targets (case-normalised) are followed, always without credentials', ssrf.slice(-3).every(x => x.status === 200 && x.auth === false));
    const chainRoute = { match: (q) => q.host === 'mms.twiliocdn.com' && q.path === '/chain', respond: () => ({ status: 302, headers: { location: 'https://media.twiliocdn.com/x' } }) };
    upstream.routes.unshift(chainRoute);
    mediaRedirect = 'https://mms.twiliocdn.com/chain';
    let t2 = (await mint(tA, [{ kind: 'mms', id: msgA, part: 0 }])).data.tickets[0];
    resetUp();
    r = await stream(t2);
    upstream.routes.shift();
    mediaRedirect = 'https://mms.twiliocdn.com/abc/def?Expires=1&Signature=CDNSIG';
    ok('X3 redirect chains (more than one hop) are refused', r.status === 502 && !upstream.requests.some(q => q.host === 'media.twiliocdn.com'));
    const rebinding = [[{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.5', family: 4 }], [{ address: '169.254.169.254', family: 4 }],
      [{ address: '::1', family: 6 }], [{ address: 'fd00::1', family: 6 }], [{ address: '::ffff:127.0.0.1', family: 6 }],
      [{ address: '52.0.0.10', family: 4 }, { address: '192.168.0.1', family: 4 }], []];
    const rb = [];
    for (const addrs of rebinding) {
      dnsMap['api.twilio.com'] = addrs;
      const t = (await mint(tA, [{ kind: 'call-recording', id: callA }])).data.tickets[0];
      resetUp();
      rb.push({ status: (await stream(t)).status, reqs: upstream.requests.length });
    }
    delete dnsMap['api.twilio.com'];
    dnsMap['mms.twiliocdn.com'] = [{ address: '10.1.1.1', family: 4 }];
    t2 = (await mint(tA, [{ kind: 'mms', id: msgA, part: 0 }])).data.tickets[0];
    resetUp();
    const rbCdn = await stream(t2);
    delete dnsMap['mms.twiliocdn.com'];
    ok('X4 DNS rebinding: a Twilio or CDN hostname resolving to loopback / private / link-local / mapped / mixed addresses is refused with no connection',
      rb.every(x => x.status === 502 && x.reqs === 0) && rbCdn.status === 502 && !upstream.requests.some(q => q.host === 'mms.twiliocdn.com'), JSON.stringify(rb));
    // Unit checks on the URL validators (encoded / alternate forms).
    const recForms = [
      `http://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE_A}`, `https://api.twilio.com.evil.example/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE_A}`,
      `https://evil@api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE_A}`, `https://api.twilio.com:444/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE_A}`,
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE_A}/../../Calls`, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`,
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE_A}%2F..%2F`, `https://api.twilio.com./2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE_A}`,
    ];
    const mediaForms = [
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${MM}`, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages`,
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${MM}/Media/${ME0}.json`,
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${MM}/Media/${ME0}?x=1#y`.replace('?x=1#y', '/../../'),
      `https://API.twilio.com:443/2010-04-01/Accounts/${OTHER_SID}/Messages/${MM}/Media/${ME0}`, 'x'.repeat(3000),
    ];
    const throws = (fn) => { try { fn(); return false; } catch { return true; } };
    ok('X5 recording validator rejects http, look-alike hosts, userinfo, odd ports, traversal, account-level paths, encoded slashes and trailing-dot hosts',
      recForms.every(u => throws(() => tr.assertSafeRecordingUrl(u))));
    ok('X6 MMS validator accepts only the exact Media resource on the configured account (not the account / messages / .json resources — the old proxy\'s escalation targets)',
      mediaForms.every(u => throws(() => tr.assertSafeTwilioMediaUrl(u))) && tr.assertSafeTwilioMediaUrl(mediaUrl(ME0)) === mediaUrl(ME0));
    const allowAll = () => true;
    ok('X7 the fetcher refuses non-https, userinfo, non-443 ports and IP-literal hosts (decimal / hex / dotted / IPv6) even if a host predicate would allow them',
      ['http://x.example/', 'https://u:p@x.example/', 'https://x.example:8443/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/', 'https://[::ffff:7f00:1]/']
        .every(u => throws(() => parseAllowed(u, allowAll))));
    const addrCases = [['52.0.0.10', 4, true], ['8.8.8.8', 4, true], ['127.0.0.1', 4, false], ['10.1.2.3', 4, false], ['172.20.0.1', 4, false], ['192.168.1.1', 4, false],
      ['169.254.169.254', 4, false], ['100.64.1.1', 4, false], ['0.0.0.0', 4, false], ['224.0.0.1', 4, false], ['255.255.255.255', 4, false], ['198.51.100.7', 4, false],
      ['2606:4700::1111', 6, true], ['::1', 6, false], ['::', 6, false], ['::ffff:127.0.0.1', 6, false], ['::ffff:8.8.8.8', 6, false], ['fe80::1', 6, false],
      ['fd12::1', 6, false], ['ff02::1', 6, false], ['64:ff9b::7f00:1', 6, false], ['2002:7f00:1::', 6, false], ['2001:db8::1', 6, false], ['127.0.0.1', 6, false],
      ['::127.0.0.1', 6, false], ['::169.254.169.254', 6, false], ['::ffff:0:7f00:1', 6, false], ['3fff::1', 6, false], ['5f00::1', 6, false], ['fd00:ec2::254', 6, false]];
    ok('X8 address policy: public unicast only (30 IPv4/IPv6 cases, incl. mapped, compatible, translated, NAT64, 6to4, CGNAT, metadata; IPv6 must be 2000::/3)', addrCases.every(([a, f, e]) => isPublicAddress(a, f) === e));
    // The first-hop host predicate is an independent layer: even a URL that
    // somehow bypassed the exact-path validators never gets credentials.
    const firstHop = async (u) => {
      resetUp();
      try { await safeGet(u, { headers: { Authorization: 'Basic x' }, isAllowed: tr.isTwilioApiUrl }); return 'fetched'; }
      catch (e) { return upstream.requests.length ? 'connected' : e.code; }
    };
    const hopBad = await Promise.all(['https://api.twilio.com.evil.example/x', 'https://evilapi.twilio.com/x', 'https://mms.twiliocdn.com/x',
      'https://api.twilio.com./x', 'https://api-twilio.com/x', 'https://api.twilio.co/x'].map(firstHop));
    upstream.routes.push({ match: (q) => q.host === 'api.twilio.com' && q.path === '/x10', respond: () => ({ status: 200, body: 'ok' }) });
    const hopGood = await firstHop('https://API.Twilio.COM/x10');
    upstream.routes.pop();
    ok('X10 first hop (credentials) only to api.twilio.com: look-alike, sibling, CDN and trailing-dot hosts are refused before DNS/connect',
      hopBad.every(r => r === 'host') && hopGood === 'fetched', JSON.stringify(hopBad.concat(hopGood)));
    dnsMap['api.twilio.com'] = [{ address: '52.0.0.11', family: 4 }, { address: '2600:1f18::11', family: 6 }];
    upstream.routes.push({ match: (q) => q.host === 'api.twilio.com' && q.path === '/x11', respond: () => ({ status: 200, body: 'ok' }) });
    resetUp();
    await safeGet('https://api.twilio.com/x11', { isAllowed: tr.isTwilioApiUrl });
    await safeGet('https://api.twilio.com/x11', { isAllowed: tr.isTwilioApiUrl });
    const x11 = upstream.requests.slice();
    upstream.routes.pop();
    delete dnsMap['api.twilio.com'];
    ok('X11 every upstream request gets a fresh socket (no keep-alive reuse that would skip the pin), pinned to all vetted addresses',
      x11.length === 2 && x11.every(q => q.agent === false && q.pinned === '52.0.0.11'
        && JSON.stringify(q.pinnedAll) === JSON.stringify([{ address: '52.0.0.11', family: 4 }, { address: '2600:1f18::11', family: 6 }])));
    upstream.routes.push({ match: (q) => q.path === '/hang', respond: () => ({ hang: true }) });
    const codeOf = async (u, ms) => {
      const t0 = Date.now();
      const guard = new Promise(r => setTimeout(() => r('hung'), 2000));
      const got = safeGet(u, { isAllowed: () => true, timeoutMs: ms }).then(() => 'fetched', (e) => e.code);
      return [await Promise.race([got, guard]), Date.now() - t0];
    };
    const slowDns = await codeOf('https://api.slowdns.test/x', 150);
    const hang = await codeOf('https://api.twilio.com/hang', 150);
    upstream.routes.pop();
    ok('X12 a DNS lookup that never answers and a server that never sends headers both fail within the deadline',
      slowDns[0] === 'dns' && slowDns[1] < 1000 && hang[0] === 'timeout' && hang[1] < 1000, JSON.stringify({ slowDns, hang }));
    ok('X9 ranges: single bounded ranges only', parseRange('bytes=0-1') && !parseRange('bytes=0-1,2-3') && !parseRange('bytes=5-1') && !parseRange('bytes=-') && !parseRange('bits=0-1')
      && fileRange(parseRange('bytes=-3'), 10).start === 7 && fileRange(parseRange('bytes=10-'), 10).unsatisfiable && fileRange(parseRange('bytes=-0'), 10).unsatisfiable);

    // ── R. Responses never carry upstream URLs / SIDs / durable tokens ────────
    const lists = [
      await req('GET', '/api/calls', { token: tA }), await req('GET', '/api/calls/by-phone/5550000001', { token: tA }),
      await req('GET', '/api/leads', { token: tA }), await req('PATCH', `/api/leads/${vmA}/status`, { token: tA, json: { status: 'Contacted' } }),
      await req('GET', '/api/messages/+15550000021', { token: tA }),
    ];
    const blob = lists.map(x => x.text).join('\n');
    ok('R1 call / lead / message responses carry no Twilio URL, Account SID, recording / media SID, CDN URL or backend media path',
      lists.every(x => x.status === 200) && !/api\.twilio\.com|twiliocdn|AC[0-9a-f]{32}|RE[0-9a-f]{32}|ME[0-9a-f]{32}|\/api\/messages\/media|LEGACYSESSIONSECRET/i.test(blob));
    const callObj = lists[0].data.find(c => c.id === callA);
    const msgObj = lists[4].data.find(m => m.id === msgA);
    ok('R2 presence is kept as flags / opaque markers so the app still knows what to show', callObj?.recording_url === true
      && lists[0].data.find(c => c.id === callNoRec)?.recording_url === null && JSON.parse(msgObj.media_urls)[0] === 'media:0' && JSON.parse(msgObj.media_urls).length === 8);
    const viaQuery2 = await req('GET', `/api/calls?token=${tA}`);
    const oldRoutes = await Promise.all([`/api/calls/${callA}/recording`, `/api/leads/${vmA}/voicemail`, `/api/messages/media-proxy?url=${encodeURIComponent(mediaUrl(ME0))}`, `/api/messages/media/${localName}`]
      .map(p => req('GET', p, { token: tA })));
    ok('R3 a session token in the URL (?token=) no longer authenticates anything; the old proxy routes are gone',
      viaQuery2.status === 401 && oldRoutes.every(x => (x.status === 404 || (x.status === 200 && x.text === '[]'))
        && !x.buf.equals(audio) && !x.buf.equals(image) && !x.buf.equals(localBytes) && !/audio|image/.test(x.headers.get('content-type') || '')));
    const inv = await req('GET', '/api/health/push-inventory', { token: tO });
    const m = inv.data?.media;
    ok('R4 owner inventory classifies stored media references by COUNT only (no values)', inv.status === 200 && m
      && m.callRecordings.total === 8 && m.callRecordings.twilio === 5 && m.callRecordings.credentialBearing === 1 && m.callRecordings.other === 2
      && m.mms.items.total === 9 && m.mms.items.twilio === 2 && m.mms.items.localUpload >= 1 && m.mms.items.legacyProxy === 2
      && !/twilio\.com|AC[0-9a-f]{32}|mms-\d|LEGACYSESSIONSECRET/.test(JSON.stringify(m)), JSON.stringify(m));

    // ── L. Logs, Sentry, housekeeping ─────────────────────────────────────────
    const allTickets = db.prepare('SELECT COUNT(*) n FROM media_tickets').get().n;
    const leakedTicket = seenTickets.concat(mmsT.filter(Boolean), [vmTicket, gT, tkImg]).filter(Boolean).some(t => logged.some(l => l.includes(t)));
    ok('L1 no ticket, Twilio URL, Account SID, auth token, Basic credential, CDN signature or file path appears in any log line',
      !leakedTicket && !logged.some(l => secrets.some(s => l.includes(s)) || /api\.twilio\.com|AC[0-9a-f]{32}|twiliocdn|plumbline-mms|Recordings\/RE/.test(l)), `tickets=${allTickets}`);
    const so = sentryPrivacyOptions({ requestDataIntegration: (o) => o, httpIntegration: (o) => o });
    const http = so.integrations[1];
    ok('L2 backend Sentry: Twilio / CDN / S3 requests are never traced and no trace headers are propagated',
      ['https://api.twilio.com/2010-04-01/x', 'https://mms.twiliocdn.com/x', 'https://s3-external-1.amazonaws.com/media.twiliocdn.com/x'].every(u => http.ignoreOutgoingRequests(u))
      && !http.ignoreOutgoingRequests('https://example.com/x') && Array.isArray(so.tracePropagationTargets) && so.tracePropagationTargets.length === 0);
    db.prepare('UPDATE media_tickets SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    await hk.runHousekeeping();
    ok('L3 housekeeping removes expired tickets', count('SELECT COUNT(*) n FROM media_tickets') === 0 && logged.some(l => /\[Housekeeping\] expired media tickets: removed \d+/.test(l)));
  } catch (err) {
    fail++; say('FAIL  harness — ' + (err.stack || err.message));
  } finally {
    server.close();
  }
}

run().then(() => {
  cleanupDb(TMP);
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {}
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
