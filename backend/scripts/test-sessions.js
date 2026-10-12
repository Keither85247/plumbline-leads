'use strict';
/**
 * Hermetic tests — session tokens stored only as hashes.
 *
 *   T. Token issue and storage: format, once-only return, hash-only storage,
 *      no raw token anywhere in the database files, indexed lookup.
 *   V. Validation: expired, malformed, unknown, stored-key replay; the
 *      pre-hashing raw-token path no longer exists.
 *   C. Concurrency: parallel sign-ins → distinct sessions, all valid.
 *   L. Logout: by hash, push cleanup scoped to the session, expired rows
 *      (grace), repeated logout, media tickets die with the session.
 *   I. Owner inventory: counts by storage form, no values, no-store.
 *   X. Exposure: no raw token or stored key in logs or other responses;
 *      credential responses are no-store.
 *   RV. One-time revocation at boot (child processes): exact counts, every
 *      row hashed and expired, media tickets deleted, nothing else changed,
 *      no raw token left in the files, runs once, a restored pre-revocation
 *      database is revoked again, fallback to deletion.
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
    ok('V3 the pre-hashing raw-token path no longer exists: an unexpired raw 64-hex row never authenticates (not even one restored from a backup)',
      r.status === 401 && session.lookupSession(legacyA) === null);
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
    // A device signed out by the revocation still holds its old 64-hex token;
    // its row was stored under the same hash and expired. Logout finds it.
    const legacyLogout = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(tok.storageKey(legacyLogout), A, iso(-1000));
    db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES (?, 'p', 'a', ?)").run('https://fcm.googleapis.com/fcm/send/dev-rev', A);
    r = await req('POST', '/auth/logout', { token: legacyLogout, json: { pushEndpoint: 'https://fcm.googleapis.com/fcm/send/dev-rev' } });
    ok('L4 a device signed out by the revocation can still log out with its old token: its revoked row is found by hash and its push registration removed',
      r.status === 200 && r.data?.ended === 1 && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tok.storageKey(legacyLogout)) === 0
      && count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%dev-rev'") === 0 && (await whoami(legacyLogout)).status === 401);
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
    ok('L7 a pre-hashing token can no longer mint media tickets', r.status === 401);

    // ── I. Owner inventory ─────────────────────────────────────────────────
    const tO = session.createSession(OWNER, 3600e3).token; issued.push(tO);
    r = await req('GET', '/api/health/push-inventory', { token: tO });
    const inv = r.data || {};
    const stored = db.prepare('SELECT token FROM sessions').all().map(x => x.token);
    ok('I1 owner inventory counts sessions by storage form (hashed / legacy raw / legacy raw active), reports the revocation record (here: a fresh database, nothing to revoke), live media tickets and the build',
      r.status === 200 && inv.sessions?.byFormat?.hashed === count("SELECT COUNT(*) n FROM sessions WHERE substr(token,1,3)='h1:'")
      && inv.sessions?.byFormat?.legacyRaw === count("SELECT COUNT(*) n FROM sessions WHERE substr(token,1,3)<>'h1:'")
      && inv.sessions?.byFormat?.legacyRawActive >= 1 && inv.sessions?.revocation?.mode === 'expired' && inv.sessions.revocation.before?.total === 0
      && typeof inv.mediaTickets?.live === 'number' && inv.build === 'abcdef1', JSON.stringify({ byFormat: inv.sessions?.byFormat, build: inv.build }));
    ok('I2 the inventory is counts only — no raw token or stored key appears — and is never cached',
      /no-store/.test(r.headers.get('cache-control') || '') && !issued.some(t => r.text.includes(t)) && !stored.some(k => r.text.includes(k)));
    const tester = await req('GET', '/api/health/push-inventory', { token: t1b });
    ok('I3 the inventory stays owner-only (tester 403, anonymous 401)', tester.status === 403 && (await req('GET', '/api/health/push-inventory')).status === 401);

    // ── RV. One-time revocation at boot (child processes, separate database) ──
    const { execFileSync } = require('child_process');
    const Database = require(path.join(BE, 'node_modules/better-sqlite3'));
    const RV = path.join(os.tmpdir(), `plumbline-sessions-rv-${process.pid}.db`);
    const REC = 'session_revocation_2026_10';
    cleanupDb(RV);
    const boot = (code = 'return null;') => JSON.parse(execFileSync(process.execPath, ['-e', `
      const out = []; for (const m of ['log','warn','error','info']) console[m] = (...a) => out.push(a.map(String).join(' '));
      require(${JSON.stringify(path.join(BE, 'db'))});
      const session = require(${JSON.stringify(path.join(BE, 'utils/session'))});
      const r = (() => { ${code} })();
      process.stdout.write(JSON.stringify({ r, logs: out }));
    `], { env: { ...process.env, DB_PATH: RV } }).toString());
    const hex64 = () => crypto.randomBytes(32).toString('hex');
    boot();                                              // schema exists (as on the deployed first commit)
    let d = new Database(RV);
    d.prepare('DELETE FROM app_settings WHERE key = ?').run(REC);       // = a database that never ran the revocation
    const u1 = Number(d.prepare("INSERT INTO users (email, display_name, password_hash) VALUES ('rv1@example.test','rv1','x')").run().lastInsertRowid);
    const u2 = Number(d.prepare("INSERT INTO users (email, display_name, password_hash) VALUES ('rv2@example.test','rv2','x')").run().lastInsertRowid);
    const L1 = hex64(), L2 = hex64(), U1 = hex64(), H1 = tok.newSessionToken(), H2 = tok.newSessionToken();
    const insS = d.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)');
    insS.run(L1, u1, iso(3600e3));                        // pre-hashing, active
    insS.run(L2, u1, iso(-2 * 864e5));                    // pre-hashing, expired (in grace)
    insS.run(U1, u2, 'not-a-date');                       // pre-hashing, unparseable expiry
    insS.run(tok.storageKey(H1), u2, iso(3600e3));        // hashed, active (signed in after the first deploy)
    insS.run(tok.storageKey(H2), u2, iso(-3600e3));       // hashed, expired
    const insT = d.prepare(`INSERT INTO media_tickets (ticket_hash,user_id,session_id,session_fp,kind,object_id,part,op,max_uses,uses,expires_at,created_at)
      VALUES (?,?,1,'fp','call-recording',1,0,'play',200,0,?,?)`);
    insT.run(hex64(), u1, iso(600e3), iso(0)); insT.run(hex64(), u2, iso(600e3), iso(0));
    d.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES ('https://fcm.googleapis.com/fcm/send/rv-dev', 'p', 'a', ?)").run(u1);
    d.prepare("INSERT INTO fcm_subscriptions (fcm_token, user_id) VALUES ('rv-fcm-token', ?)").run(u1);
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('sessions','media_tickets','app_settings') AND name NOT LIKE 'sqlite_%'").all().map(x => x.name);
    const fingerprint = (db_) => Object.fromEntries(tables.map(t => [t, crypto.createHash('sha256').update(JSON.stringify(db_.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all())).digest('hex')]));
    const before = fingerprint(d);
    d.close();

    // While the server keeps running (no close-time checkpoint yet), the WAL
    // must already be free of the replaced raw tokens.
    const b1 = boot(`const fs = require('fs'); const wal = ${JSON.stringify(RV + '-wal')};
                     const walBytes = fs.existsSync(wal) ? fs.readFileSync(wal) : Buffer.alloc(0);
                     const mainBytes = fs.readFileSync(${JSON.stringify(RV)});
                     return { lookups: ${JSON.stringify([L1, L2, U1, H1, H2])}.map(t => session.lookupSession(t)),
                              found: ${JSON.stringify([L1, H1])}.map(t => !!session.findSessionRow(t)),
                              walHasRaw: ${JSON.stringify([L1, L2, U1])}.some(t => walBytes.includes(Buffer.from(t))),
                              mainHasRaw: ${JSON.stringify([L1, L2, U1])}.some(t => mainBytes.includes(Buffer.from(t))) };`);
    d = new Database(RV);
    const rows = d.prepare('SELECT token, expires_at FROM sessions').all();
    const rec = JSON.parse(d.prepare('SELECT value FROM app_settings WHERE key = ?').get(REC)?.value || 'null');
    ok('RV1 first boot revokes every session once: all 5 rows rewritten to the hashed form and expired, none usable',
      rows.length === 5 && rows.every(r => tok.STORAGE_KEY_RE.test(r.token))
      && d.prepare("SELECT COUNT(*) n FROM sessions WHERE julianday(expires_at) > julianday('now') OR julianday(expires_at) IS NULL").get().n === 0
      && [L1, L2, U1].every(t => d.prepare('SELECT COUNT(*) n FROM sessions WHERE token = ?').get(tok.storageKey(t)).n === 1));
    ok('RV2 the record holds exact pre-revocation counts (never values): 5 total, 2 active, 2 expired, 1 unparseable, 3 legacy raw (1 active), 2 hashed',
      rec?.mode === 'expired' && rec.before.total === 5 && rec.before.active === 2 && rec.before.expired === 2 && rec.before.unparseable === 1
      && rec.before.legacyRaw === 3 && rec.before.legacyRawActive === 1 && rec.before.hashed === 2 && rec.rawTokensHashed === 3
      && rec.invalidated === 3 && rec.mediaTicketsDeleted === 2 && rec.remainingUsable === 0 && !JSON.stringify(rec).match(/[0-9a-f]{64}|pl1_/), JSON.stringify(rec));
    ok('RV3 no revoked token authenticates afterwards — pre-hashing or hashed', b1.r.lookups.every(x => x === null));
    ok('RV4 …but a signed-out device can still find its revoked row at logout (by hash) to remove its own push registration', b1.r.found.every(Boolean));
    ok('RV5 media tickets (bound to sessions) are deleted', d.prepare('SELECT COUNT(*) n FROM media_tickets').get().n === 0);
    ok('RV6 nothing else changes: users, push and FCM registrations and every other table are byte-for-byte identical',
      JSON.stringify(fingerprint(d)) === JSON.stringify(before));
    ok('RV7 the boot log reports counts only — no token or stored key',
      b1.logs.some(l => /one-time revocation \(expired\): 2 active session\(s\) revoked; 5 row\(s\) retired; 2 media ticket\(s\) deleted/.test(l))
      && ![L1, L2, U1, H1, H2].some(t => b1.logs.some(l => l.includes(t) || l.includes(tok.storageKey(t)))), b1.logs.join(' | '));
    d.close();
    const rvFiles = [RV, `${RV}-wal`].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f));
    ok('RV8 the replaced raw tokens are gone from the database files — the WAL while the server is still running (checkpoint) and the main file (secure_delete)',
      b1.r.walHasRaw === false && b1.r.mainHasRaw === false && ![L1, L2, U1].some(t => rvFiles.some(b => b.includes(Buffer.from(t)))));

    // Second boot: never runs again; sessions created after the revocation survive.
    const fresh = boot(`return session.createSession(${u1}, 3600e3).token;`).r;
    const b2 = boot(`return { fresh: !!session.lookupSession(${JSON.stringify(fresh)}) };`);
    d = new Database(RV);
    const rec2 = JSON.parse(d.prepare('SELECT value FROM app_settings WHERE key = ?').get(REC).value);
    ok('RV9 later boots do not revoke again: the record is unchanged and a session created after the revocation still works',
      rec2.at === rec.at && b2.r.fresh === true && !b2.logs.some(l => /one-time revocation/.test(l)));
    // A database restored from before the revocation (no record) is revoked again.
    const L3 = hex64();
    d.prepare('DELETE FROM app_settings WHERE key = ?').run(REC);
    d.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(L3, u1, iso(3600e3));
    d.close();
    const b3 = boot(`return { l3: session.lookupSession(${JSON.stringify(L3)}), fresh: session.lookupSession(${JSON.stringify(fresh)}) };`);
    d = new Database(RV);
    ok('RV10 a restored pre-revocation database is revoked again on boot (a restored raw row can never authenticate)',
      b3.r.l3 === null && b3.r.fresh === null && !!d.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(REC)
      && d.prepare('SELECT COUNT(*) n FROM sessions WHERE token = ?').get(tok.storageKey(L3)).n === 1);
    // Fallback: if the rewrite cannot complete, every session is deleted instead.
    d.prepare('DELETE FROM app_settings WHERE key = ?').run(REC);
    d.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(hex64(), u1, iso(3600e3));
    d.exec("CREATE TRIGGER rv_block BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    d.close();
    const b4 = boot();
    d = new Database(RV);
    const rec4 = JSON.parse(d.prepare('SELECT value FROM app_settings WHERE key = ?').get(REC)?.value || 'null');
    ok('RV11 if the rewrite fails, every session is deleted instead (mode "deleted") and the server still starts',
      rec4?.mode === 'deleted' && d.prepare('SELECT COUNT(*) n FROM sessions').get().n === 0 && b4.logs.some(l => /deleting all sessions instead/.test(l)));
    d.exec('DROP TRIGGER rv_block');
    d.close();
    cleanupDb(RV);

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
