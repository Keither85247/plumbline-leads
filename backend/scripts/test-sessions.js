'use strict';
/**
 * Hermetic tests — session tokens stored only as hashes.
 *
 *   T. Token issue and storage: format, once-only return, hash-only storage,
 *      no raw token anywhere in the database files, indexed lookup.
 *   V. Validation: expired, malformed, unknown, stored-key replay, legacy
 *      transition rows (raw 64-hex) — and that a hashed row can never be
 *      matched by the legacy path.
 *   C. Concurrency: parallel sign-ins → distinct sessions, all valid.
 *   L. Logout: by hash, push cleanup scoped to the session, expired rows
 *      (grace), repeated logout, media tickets die with the session.
 *   I. Owner inventory: counts by storage form, no values, no-store.
 *   X. Exposure: no raw token or stored key in logs or other responses;
 *      credential responses are no-store.
 *
 * Temp DB, real routers over HTTP, no network. Run:
 *   OPENAI_API_KEY=sk-test node scripts/test-sessions.js
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');
const Module = require('module');

const BE  = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `plumbline-sessions-test-${process.pid}.db`);
const cleanupDb = (p) => { for (const f of [p, `${p}-wal`, `${p}-shm`]) { try { fs.unlinkSync(f); } catch {} } };
cleanupDb(TMP);
process.env.DB_PATH  = TMP;
process.env.DATA_DIR = path.join(os.tmpdir(), `plumbline-sessions-data-${process.pid}`);
Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: 'AC' + 'a1'.repeat(16), TWILIO_AUTH_TOKEN: 'test_twilio_secret',
  OPENAI_API_KEY: 'sk-test-not-used', FRONTEND_URL: 'https://app.example.test',
  TWILIO_API_KEY_SID: 'SK' + 'c3'.repeat(16), TWILIO_API_KEY_SECRET: 'test_api_secret',
  TWILIO_TWIML_APP_SID: 'AP' + 'd4'.repeat(16), RENDER_GIT_COMMIT: 'abcdef1234567890',
});
delete process.env.NODE_ENV;

const logged = [];
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (process.env.VERBOSE) orig(...a); };
}
const origStdout = process.stdout.write.bind(process.stdout);
const say = (s) => origStdout(s + '\n');

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'openai') return class OpenAI { constructor() { this.chat = { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } }; this.audio = { transcriptions: { create: async () => ({ text: '' }) } }; } };
  if (request === 'googleapis') return { google: { auth: { OAuth2: function () { return { generateAuthUrl: () => '', on() {} }; } }, gmail: () => ({}), oauth2: () => ({}) } };
  return origLoad.apply(this, arguments);
};

const express      = require(path.join(BE, 'node_modules/express'));
const cookieParser = require(path.join(BE, 'node_modules/cookie-parser'));
const bcrypt       = require(path.join(BE, 'node_modules/bcrypt'));
const db           = require(path.join(BE, 'db'));
const session      = require(path.join(BE, 'utils/session'));
const tok          = require(path.join(BE, 'utils/sessionToken'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); say(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const count = (sql, ...p) => db.prepare(sql).get(...p).n;

const PW = 'correct-horse-battery';
const HASH = bcrypt.hashSync(PW, 4);
const mkUser = (email, { owner = false } = {}) => Number(db.prepare(
  'INSERT INTO users (email, display_name, password_hash, is_owner) VALUES (?,?,?,?)').run(email, email, HASH, owner ? 1 : 0).lastInsertRowid);
const OWNER = mkUser('owner@example.test', { owner: true });
const A = mkUser('a@example.test');
const B = mkUser('b@example.test');
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
// A pre-hashing session row exactly as the old code wrote it (raw 64-hex).
const legacyRow = (uid, ms = 3600e3) => {
  const raw = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(raw, uid, iso(ms));
  return raw;
};

(async () => {
  const authRouter  = require(path.join(BE, 'routes/auth'));
  const requireAuth = require(path.join(BE, 'middleware/requireAuth'));
  const requireOwner = require(path.join(BE, 'middleware/requireOwner'));
  const health      = require(path.join(BE, 'routes/health'));
  const media       = require(path.join(BE, 'routes/media'));
  const tokenRouter = require(path.join(BE, 'routes/token'));
  const { purgeExpiredSessions } = (() => { try { return require(path.join(BE, 'jobs/housekeeping')); } catch { return {}; } })();

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/api/media', media.publicRouter);
  app.use('/api/twilio/token', tokenRouter);
  app.use(requireAuth);
  app.get('/api/whoami', (req, res) => res.json({ userId: req.userId }));
  app.use('/api/media', media.router);
  app.use('/api/health', requireOwner, health.ownerRouter);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, p, { token, cookie, json, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (cookie) h.Cookie = `plumbline_session=${cookie}`;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(base + p, { method, headers: h, body });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, text, data, headers: r.headers, setCookies: r.headers.getSetCookie?.() || [] };
  }
  const login = (email) => req('POST', '/auth/login', { json: { email, password: PW } });
  const cookieVal = (r) => {
    const c = r.setCookies.find(s => s.startsWith('plumbline_session='));
    return c ? decodeURIComponent(c.split(';')[0].slice('plumbline_session='.length)) : null;
  };
  const whoami = async (t, how = 'bearer') => (await req('GET', '/api/whoami', how === 'cookie' ? { cookie: t } : { token: t }));
  const issued = [];          // every raw token handed out in this run (for leak scans)
  const resetLimits = () => Object.values(authRouter.loginLimits).forEach(l => l.clear?.());

  try {
    // ── T. Issue + storage ──────────────────────────────────────────────────
    let r = await login('a@example.test');
    const tA = r.data?.token;
    issued.push(tA);
    const rowA = tA && db.prepare('SELECT rowid AS id, * FROM sessions WHERE token = ?').get(tok.storageKey(tA));
    ok('T1 sign-in returns a fresh 256-bit token (pl1_ + 43 base64url) in the body and the httpOnly cookie, and the body is no-store',
      r.status === 200 && tok.TOKEN_RE.test(tA || '') && cookieVal(r) === tA && /no-store/.test(r.headers.get('cache-control') || '')
      && r.setCookies.some(c => /HttpOnly/i.test(c)));
    const expectKey = 'h1:' + crypto.createHash('sha256').update('plumbline/session-token/v1\0' + tA).digest('hex');
    ok('T2 only the domain-separated SHA-256 of the token is stored (h1:<hex>); no row holds the raw token',
      rowA && rowA.token === expectKey && rowA.user_id === A && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tA) === 0
      && count("SELECT COUNT(*) n FROM sessions WHERE substr(token,1,3) <> 'h1:'") === 0);
    r = await whoami(tA);
    const rc = await whoami(tA, 'cookie');
    ok('T3 the raw token authenticates (Bearer and cookie) through the hashed lookup', r.status === 200 && r.data?.userId === A && rc.status === 200 && rc.data?.userId === A);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT s.rowid FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND julianday(s.expires_at) > julianday('now')").all('h1:x').map(x => x.detail).join(' | ');
    ok('T4 the lookup is an indexed primary-key search, not a scan', /SEARCH s USING INDEX sqlite_autoindex_sessions_1/.test(plan), plan);
    const looked = session.lookupSession(tA);
    ok('T5 lookupSession returns the stored row identity (rowid + stored key), never the raw token',
      looked && looked.userId === A && looked.sessionId === rowA.id && looked.sessionKey === expectKey && !JSON.stringify(looked).includes(tA));
    resetLimits();
    r = await login('b@example.test');
    const tB = r.data.token; issued.push(tB);
    const t1b = (await login('b@example.test')).data.token; issued.push(t1b);
    let threw = false, same = null;
    try { same = tok.sameKey('h1:' + 'é'.repeat(64), 'h1:' + 'a'.repeat(64)) || tok.sameKey(expectKey, expectKey.slice(0, -1) + '€') || tok.sameKey(null, expectKey); } catch { threw = true; }
    ok('T7 the constant-time key comparison returns false (never throws) for malformed or non-hex input', !threw && same === false && tok.sameKey(expectKey, expectKey) === true);
    const meA = await req('GET', '/auth/me', { token: tA });
    ok('T8 the profile returned at sign-in and by /auth/me includes the business name (per-account names on the device need no cache)',
      'business_name' in (meA.data || {}));
    ok('T6 every sign-in gets its own token and row (no reuse, no shared secret)', tB !== t1b && tB !== tA
      && count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', B) === 2);

    // ── V. Validation ──────────────────────────────────────────────────────
    const expired = session.createSession(A, -1000).token; issued.push(expired);
    const legacyA = legacyRow(A);
    const legacyExpired = legacyRow(A, -1000);
    const variants = {
      expiredNew:      expired,
      unknownNew:      tok.newSessionToken(),
      storedKey:       expectKey,                         // a value read from a disclosed database
      storedHexOnly:   expectKey.slice(3),                // the digest without its prefix (64 hex)
      prefixOnly:      'pl1_',
      shortNew:        'pl1_' + 'a'.repeat(42),
      longNew:         'pl1_' + 'a'.repeat(44),
      badChars:        'pl1_' + 'a'.repeat(42) + '=',
      hex32:           crypto.randomBytes(16).toString('hex'),
      hexUpper:        legacyA.toUpperCase(),
      legacyExpired,
      huge:            'pl1_' + 'a'.repeat(5000),
      sqlish:          "' OR 1=1 --",
    };
    const results = {};
    for (const [k, v] of Object.entries(variants)) {
      const b = await whoami(v);
      results[k] = b.status;
    }
    ok('V1 expired, unknown, malformed, oversized, wrong-case and expired-legacy tokens are all refused (401)',
      Object.values(results).every(s => s === 401), JSON.stringify(results));
    ok('V2 a stored key (h1:…) or its bare digest presented as Bearer or cookie never authenticates — database disclosure does not yield usable sessions',
      results.storedKey === 401 && results.storedHexOnly === 401 && (await whoami(expectKey, 'cookie')).status === 401
      && session.lookupSession(expectKey) === null && session.lookupSession(expectKey.slice(3)) === null);
    r = await whoami(legacyA);
    ok('V3 transition: an unexpired pre-hashing session (raw 64-hex row) still authenticates, so the deploy itself signs nobody out',
      r.status === 200 && r.data?.userId === A);
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('h1:' + 'ab'.repeat(32), B, iso(3600e3));
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('legacy-not-hex-token-value', A, iso(3600e3));
    ok('V6 only the exact pre-hashing format (64 lowercase hex) can use the legacy path — other raw values never authenticate',
      (await whoami('legacy-not-hex-token-value')).status === 401 && session.lookupSession('legacy-not-hex-token-value') === null);
    ok('V5 new sessions are never written in the legacy form', count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND substr(token,1,3) <> 'h1:'", B) === 0);

    // ── C. Concurrency ─────────────────────────────────────────────────────
    resetLimits();
    const par = await Promise.all(Array.from({ length: 12 }, () => login('b@example.test')));
    const ptoks = par.map(x => x.data?.token);
    issued.push(...ptoks.filter(Boolean));
    const pAuth = await Promise.all(ptoks.map(t => whoami(t)));
    ok('C1 12 concurrent sign-ins → 12 distinct tokens and rows, each authenticating as its own session',
      par.every(x => x.status === 200) && new Set(ptoks).size === 12 && pAuth.every(x => x.status === 200 && x.data.userId === B)
      && ptoks.every(t => count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tok.storageKey(t)) === 1));

    // ── L. Logout ──────────────────────────────────────────────────────────
    db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES (?, 'p', 'a', ?)").run('https://fcm.googleapis.com/fcm/send/dev-a', A);
    db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES (?, 'p', 'a', ?)").run('https://fcm.googleapis.com/fcm/send/dev-b', B);
    const tA2 = session.createSession(A, 3600e3).token; issued.push(tA2);
    r = await req('POST', '/auth/logout', { token: tA2, json: { pushEndpoint: 'https://fcm.googleapis.com/fcm/send/dev-a' } });
    ok('L1 logout ends the session by its hash: the row is gone, the token no longer works, this device\'s push row is removed; the reply says 1 presented, 1 ended (counts only)',
      r.status === 200 && r.data?.presented === 1 && r.data?.ended === 1 && /no-store/.test(r.headers.get('cache-control') || '') && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tok.storageKey(tA2)) === 0
      && (await whoami(tA2)).status === 401 && count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%dev-a'") === 0);
    r = await req('POST', '/auth/logout', { token: tB, json: { pushEndpoint: 'https://fcm.googleapis.com/fcm/send/dev-a' } });
    ok('L2 push cleanup is scoped to the session\'s own account (B cannot remove A\'s device)',
      count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%dev-b'") === 1);
    // Expired (within grace) session: logout still finds it to clean up its device.
    db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES (?, 'p', 'a', ?)").run('https://fcm.googleapis.com/fcm/send/dev-a2', A);
    r = await req('POST', '/auth/logout', { token: expired, json: { pushEndpoint: 'https://fcm.googleapis.com/fcm/send/dev-a2' } });
    ok('L3 an expired session (still within the housekeeping grace) is found at logout so its device is cleaned up, then removed',
      r.status === 200 && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tok.storageKey(expired)) === 0
      && count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%dev-a2'") === 0);
    const legacyLogout = legacyRow(A);
    r = await req('POST', '/auth/logout', { token: legacyLogout });
    ok('L4 a pre-hashing (raw) session can still log out during the transition', r.status === 200 && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', legacyLogout) === 0);
    const again = await req('POST', '/auth/logout', { token: tA2 });
    const junk = await req('POST', '/auth/logout', { token: 'h1:' + 'ab'.repeat(32) });
    const none = await req('POST', '/auth/logout', {});
    ok('L5 repeated or unknown logouts are harmless 200s (already signed out) and never touch other rows — a stored key cannot delete its own row; a request with no credential is reported as presented 0 (never a confirmation)',
      again.status === 200 && again.data?.presented === 1 && again.data?.ended === 0 && junk.status === 200 && none.data?.presented === 0 && none.data?.ended === 0 && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', 'h1:' + 'ab'.repeat(32)) === 1);
    // A page that is closing may send its token as a text/plain body (no preflight).
    const tU = session.createSession(A, 3600e3).token; issued.push(tU);
    const rU = await fetch(base + '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: tU }) });
    const dU = await rU.json();
    const bodyAuth = await fetch(base + '/api/whoami', { method: 'GET', headers: { 'Content-Type': 'text/plain' }, body: undefined });
    ok('L9 an unload-time text/plain body token ends ITS session (logout only) — and a body token never authenticates anything else',
      rU.status === 200 && dU.presented === 1 && dU.ended === 1 && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tok.storageKey(tU)) === 0
      && bodyAuth.status === 401);
    // Logout's delete is bound to the row it found: if another process removed
    // that row and SQLite gave its rowid to a new session, the delete misses.
    const tR = session.createSession(A, 3600e3).token; issued.push(tR);
    const found = session.findSessionRow(tR);
    db.prepare('DELETE FROM sessions WHERE rowid = ?').run(found.sessionId);
    db.prepare('INSERT INTO sessions (rowid, token, user_id, expires_at) VALUES (?,?,?,?)').run(found.sessionId, tok.storageKey(tok.newSessionToken()), B, iso(3600e3));
    const removed = session.deleteSessionRow(found);
    ok('L8 a logout delete never removes another session that reused the row id (it is bound to the stored key)',
      removed === 0 && count('SELECT COUNT(*) n FROM sessions WHERE rowid = ? AND user_id = ?', found.sessionId, B) === 1);
    // Media tickets follow the session (rowid + stored-key fingerprint).
    const greetDir = require(path.join(BE, 'routes/settings')).userGreetingDir(A);
    fs.mkdirSync(greetDir, { recursive: true });
    fs.writeFileSync(path.join(greetDir, 'g.mp3'), Buffer.from('ID3-greeting'));
    db.prepare("INSERT INTO voicemail_greetings (user_id, type, audio_file, public_token) VALUES (?, 'audio', 'g.mp3', ?)").run(A, crypto.randomBytes(32).toString('hex'));
    const tM = session.createSession(A, 3600e3).token; issued.push(tM);
    r = await req('POST', '/api/media/tickets', { token: tM, json: { items: [{ kind: 'greeting' }] }, headers: { Origin: 'https://app.example.test' } });
    const mt = r.data?.tickets?.[0];
    const s1 = await req('GET', `/api/media/stream?mt=${mt}`);
    await req('POST', '/auth/logout', { token: tM });
    const s2 = await req('GET', `/api/media/stream?mt=${mt}`);
    const fp = db.prepare('SELECT session_fp FROM media_tickets').all().map(x => x.session_fp);
    ok('L6 media tickets minted by a hashed session stream, and die with it at logout (fingerprint over the stored key, own domain tag)',
      typeof mt === 'string' && s1.status === 200 && s2.status === 404 && fp.length > 0
      && fp.every(x => x !== tok.storageKey(tM) && x !== crypto.createHash('sha256').update(`session:${tM}`).digest('hex')));
    const tL = legacyRow(A);
    r = await req('POST', '/api/media/tickets', { token: tL, json: { items: [{ kind: 'greeting' }] }, headers: { Origin: 'https://app.example.test' } });
    const s3 = await req('GET', `/api/media/stream?mt=${r.data?.tickets?.[0]}`);
    ok('L7 transition: a pre-hashing session can still mint and play media', s3.status === 200);

    // ── I. Owner inventory ─────────────────────────────────────────────────
    const tO = session.createSession(OWNER, 3600e3).token; issued.push(tO);
    r = await req('GET', '/api/health/push-inventory', { token: tO });
    const inv = r.data || {};
    const stored = db.prepare('SELECT token FROM sessions').all().map(x => x.token);
    ok('I1 owner inventory counts sessions by storage form (hashed / legacy raw / legacy raw active), reports no revocation yet, live media tickets and the build',
      r.status === 200 && inv.sessions?.byFormat?.hashed === count("SELECT COUNT(*) n FROM sessions WHERE substr(token,1,3)='h1:'")
      && inv.sessions?.byFormat?.legacyRaw === count("SELECT COUNT(*) n FROM sessions WHERE substr(token,1,3)<>'h1:'")
      && inv.sessions?.byFormat?.legacyRawActive >= 1 && inv.sessions?.revocation === null
      && typeof inv.mediaTickets?.live === 'number' && inv.build === 'abcdef1', JSON.stringify({ byFormat: inv.sessions?.byFormat, build: inv.build }));
    ok('I2 the inventory is counts only — no raw token or stored key appears — and is never cached',
      /no-store/.test(r.headers.get('cache-control') || '') && !issued.some(t => r.text.includes(t)) && !stored.some(k => r.text.includes(k)));
    const tester = await req('GET', '/api/health/push-inventory', { token: t1b });
    ok('I3 the inventory stays owner-only (tester 403, anonymous 401)', tester.status === 403 && (await req('GET', '/api/health/push-inventory')).status === 401);

    // ── X. Exposure ────────────────────────────────────────────────────────
    const vt = await req('GET', '/api/twilio/token', { token: tO });
    ok('X1 the Voice access token response is never cached', vt.status === 200 && /no-store/.test(vt.headers.get('cache-control') || ''));
    const me = await req('GET', '/auth/me', { token: tO });
    ok('X2 /auth/me and other responses never return the session token or its stored key',
      me.status === 200 && !me.text.includes(tO) && !stored.some(k => me.text.includes(k)) && !('token' in (me.data || {})));
    if (purgeExpiredSessions) { try { await purgeExpiredSessions(); } catch {} }
    const allStored = db.prepare('SELECT token FROM sessions').all().map(x => x.token);
    const leakedRaw = issued.filter(t => logged.some(l => l.includes(t)));
    const leakedKey = allStored.concat([expectKey]).filter(k => logged.some(l => l.includes(k)));
    ok('X3 no raw token and no stored key appears in any log line (sign-in, lookup, logout, media, inventory, housekeeping)',
      leakedRaw.length === 0 && leakedKey.length === 0, `raw=${leakedRaw.length} key=${leakedKey.length} lines=${logged.length}`);
    // The database files themselves never contain a new-format raw token.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const files = [TMP, `${TMP}-wal`].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f));
    const inFile = issued.filter(t => files.some(b => b.includes(Buffer.from(t))));
    ok('X4 the database files (main + WAL) contain none of the raw tokens issued in this run', inFile.length === 0, `found=${inFile.length}`);
  } catch (err) {
    fail++;
    say(`FAIL  harness error: ${err.stack}`);
  } finally {
    server.close();
    cleanupDb(TMP);
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {}
    say(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
