'use strict';
/**
 * DEF-9 security tests (RELEASE_READINESS_TEST_REPORT.md): auth hardening.
 *
 *   A. Gmail OAuth: start → launch → callback (parked) → explicit completion.
 *      Desktop (cookie), Safari-style (Bearer only), Android (WebView start,
 *      external-browser finish); CSRF; replay; cross-account preview/complete;
 *      browser swap; code injection with and without PKCE; interrupted and
 *      expired attempts; cancel; address change; revoke via request body;
 *      Sentry scrubbing; no secrets in logs.
 *   B. Suspension and session expiry: suspended users cannot sign in, open
 *      sessions stop working, expiry is exact (absolute UTC).
 *   C. Rate limits: login (per email+IP, per IP, per email) with generic
 *      responses; transcription per account and globally; limiter unit tests.
 *   D. Push identifier validation (intake, send-time skip, delete/logout).
 *   E. contacts migration: fresh DB, legacy DBs, already-migrated DB.
 *
 * Hermetic: temp SQLite DBs, synthetic accounts, fake Google/OpenAI/web-push,
 * no network, no production data.
 *
 * Run:  node backend/scripts/test-auth-hardening.js
 * Exit: 0 = all pass, 1 = any failure.
 */
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');
const Module = require('module');
const { execFileSync } = require('child_process');

const BE  = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `plumbline-hardening-test-${process.pid}.db`);
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.DB_PATH  = TMP;
process.env.DATA_DIR = path.join(os.tmpdir(), `plumbline-hardening-data-${process.pid}`);

const AUTH_TOKEN = 'test_auth_token_' + crypto.randomBytes(8).toString('hex');
const BASE_URL   = 'https://backend.example.onrender.com';
Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_BASE_URL: BASE_URL,
  TWILIO_PHONE_NUMBER: '+15550000000', TWILIO_TWIML_APP_SID: 'AP' + '0'.repeat(32),
  OPENAI_API_KEY: 'sk-test-not-used',
  GMAIL_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'fake-client-id', GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  GOOGLE_REDIRECT_URI: `${BASE_URL}/auth/google/callback`,
  FRONTEND_URL: 'https://app.example.test,https://second.example.test',
  TRUST_CF_CONNECTING_IP: 'true',
});
delete process.env.NODE_ENV;
delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;
delete process.env.VAPID_PUBLIC_KEY; delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

// ── Capture all console output (to prove secrets are never logged) ───────────
const logged = [];
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (process.env.VERBOSE) orig(...a); };
}
const origStdout = process.stdout.write.bind(process.stdout);
const say = (s) => origStdout(s + '\n');

// ── Fake Google OAuth client ─────────────────────────────────────────────────
const google = { instances: 0, getTokenCalls: 0, revoked: [], revokeRequests: [], nextScope: null, emailFor: {},
  issued: {}, used: new Set(), lastVerifier: null, noRefresh: false };
const FULL_SCOPE = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email';
class FakeOAuth2 {
  constructor() { google.instances++; this.creds = null; }
  generateAuthUrl(o) {
    const q = new URLSearchParams({ state: o.state, scope: 'x', prompt: o.prompt || '', access_type: o.access_type || '' });
    if (o.code_challenge) { q.set('code_challenge', o.code_challenge); q.set('code_challenge_method', o.code_challenge_method); }
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  // Behaves like Google's token endpoint: one-time codes, PKCE-bound when issued with a challenge.
  async getToken(arg) {
    google.getTokenCalls++;
    const code = typeof arg === 'string' ? arg : arg?.code;
    const verifier = typeof arg === 'object' ? arg?.codeVerifier : undefined;
    const invalid = () => Object.assign(new Error(`invalid_grant for ${code}`), { code: 'invalid_grant' });
    if (code === 'boom') throw Object.assign(new Error('token endpoint failed for code=boom SECRET-boom'), { code: 'invalid_grant' });
    if (google.used.has(code)) throw invalid();
    google.used.add(code);
    const iss = google.issued[code];
    if (iss?.challenge) {
      if (!verifier || crypto.createHash('sha256').update(verifier).digest('base64url') !== iss.challenge) throw invalid();
    }
    if (verifier) google.lastVerifier = verifier;
    return { tokens: { access_token: `AT-${code}`, ...(google.noRefresh ? {} : { refresh_token: `RT-${code}` }), expiry_date: Date.now() + 3600e3, scope: google.nextScope ?? FULL_SCOPE } };
  }
  setCredentials(t) { this.creds = t; }
  async revokeToken(t) { google.revoked.push(t); }
}
let whisperCalls = 0;
// utils/googleRevoke.js POSTs to Google's revoke endpoint over https: capture it.
const fakeRevokeHttps = {
  request(opts, cb) {
    const r = { on() { return r; }, destroy() {}, end(body) {
      google.revokeRequests.push({ host: opts.host, path: opts.path, method: opts.method, body: String(body) });
      google.revoked.push(new URLSearchParams(String(body)).get('token'));
      setImmediate(() => cb({ statusCode: 200, resume() {} }));
    } };
    return r;
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'https' && parent && /utils[\\/]googleRevoke\.js$/.test(parent.filename)) return fakeRevokeHttps;
  if (request === 'googleapis') {
    return { google: {
      auth: { OAuth2: FakeOAuth2 },
      oauth2: ({ auth }) => ({ userinfo: { get: async () => ({ data: { email: google.emailFor[auth.creds?.access_token] || 'someone@example.test' } }) } }),
    } };
  }
  if (request === 'openai') {
    return class OpenAI { constructor() {
      this.audio = { transcriptions: { create: async ({ file } = {}) => { whisperCalls++; if (file?.[Symbol.asyncIterator]) { for await (const _ of file) {} } return { text: 'Need a quote for a leaking pipe.' }; } } };
      this.chat = { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ contactName: 'Pat', category: 'Lead', summary: 's', keyPoints: [], followUpText: '' }) } }] }) } };
    } };
  }
  return origLoad.apply(this, arguments);
};
const gmailPath = require.resolve(path.join(BE, 'services/gmailService.js'));
require.cache[gmailPath] = { id: gmailPath, filename: gmailPath, loaded: true,
  exports: { createBaseClient: () => new FakeOAuth2(), syncRecentEmails: async () => {}, isConnected: () => false } };

const express      = require(path.join(BE, 'node_modules/express'));
const cookieParser = require(path.join(BE, 'node_modules/cookie-parser'));
const twilio       = require(path.join(BE, 'node_modules/twilio'));
const bcrypt       = require(path.join(BE, 'node_modules/bcrypt'));
const db           = require(path.join(BE, 'db'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); say(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const count = (sql, ...p) => db.prepare(sql).get(...p).n;

// ── Accounts ────────────────────────────────────────────────────────────────
const PW = 'correct-horse-battery';
const HASH = bcrypt.hashSync(PW, 4);
function mkUser(email, { owner = false, suspended = false } = {}) {
  return Number(db.prepare('INSERT INTO users (email, display_name, password_hash, is_owner, is_suspended) VALUES (?,?,?,?,?)')
    .run(email, email, HASH, owner ? 1 : 0, suspended ? 1 : 0).lastInsertRowid);
}
function mkSession(userId, msFromNow = 3600e3) {
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(t, userId, new Date(Date.now() + msFromNow).toISOString());
  return t;
}
const OWNER = mkUser('owner@example.test', { owner: true });
const A = mkUser('a@example.test'), B = mkUser('b@example.test'), C = mkUser('c@example.test');
const SUSP = mkUser('suspended@example.test', { suspended: true });

async function run() {
  const authRouter   = require(path.join(BE, 'routes/auth'));
  const requireAuth  = require(path.join(BE, 'middleware/requireAuth'));
  const pushRouter   = require(path.join(BE, 'routes/push'));
  const twilioRouter = require(path.join(BE, 'routes/twilio'));
  const transcribe   = require(path.join(BE, 'routes/transcribe'));
  const leadsRouter  = require(path.join(BE, 'routes/leads'));
  const health       = require(path.join(BE, 'routes/health'));
  const requireOwner = require(path.join(BE, 'middleware/requireOwner'));
  const { createLimiter } = require(path.join(BE, 'utils/rateLimiter'));
  const { clientIpKey }   = require(path.join(BE, 'utils/clientIp'));

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/health', health.publicRouter);
  app.use('/auth', authRouter);
  app.use('/api/twilio', twilioRouter);
  app.use(requireAuth);
  app.use('/api/health', requireOwner, health.ownerRouter);
  app.use('/api/leads', leadsRouter);
  app.get('/api/whoami', (req, res) => res.json({ userId: req.userId }));
  app.use('/api/push', pushRouter);
  app.use('/api/transcribe', transcribe);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, p, { token, cookies = {}, json, form, headers = {}, ip } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const ck = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) h.Cookie = ck;
    if (ip) h['CF-Connecting-IP'] = ip;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, text, data, headers: r.headers, setCookies: r.headers.getSetCookie?.() || [] };
  }
  const cookieVal = (setCookies, name) => {
    const c = setCookies.find(s => s.startsWith(name + '='));
    return c ? decodeURIComponent(c.split(';')[0].slice(name.length + 1)) : null;
  };

  try {
    // ── A. Gmail OAuth: start → launch → callback (parked) → explicit completion ──
    const ORIGIN = 'https://app.example.test';
    const tA = mkSession(A), tB = mkSession(B), tC = mkSession(C);
    const bearer = (t) => ({ token: t });
    const cookie = (t) => ({ cookies: { plumbline_session: t } });
    const flowRows = (uid) => db.prepare('SELECT * FROM gmail_oauth_flows WHERE user_id = ? ORDER BY id').all(uid);
    const lastFlow = (uid) => db.prepare('SELECT * FROM gmail_oauth_flows WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
    const clearGmailLimits = () => Object.values(authRouter.gmailLimits).forEach(l => l.clear());
    const start = (auth, { origin = ORIGIN, json = {}, headers = {} } = {}) =>
      req('POST', '/auth/google/start', { ...auth, json, headers: { ...(origin ? { Origin: origin } : {}), ...headers } });
    const ticketOf = (r) => { try { return new URL(r.data.launchUrl).searchParams.get('t'); } catch { return null; } };
    const launchGet = (t, cookies = {}) => req('GET', `/auth/google/launch?t=${encodeURIComponent(t)}`, { cookies });
    const launchPost = (t, origin = ORIGIN) => req('POST', '/auth/google/launch', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, form: `t=${encodeURIComponent(t)}` });
    const gUrl = (r) => { try { return new URL(r.headers.get('location')); } catch { return null; } };
    const stateOf = (r) => gUrl(r)?.searchParams.get('state');
    const nonceOf = (r) => cookieVal(r.setCookies, 'plumbline_goauth');
    let codeSeq = 0;
    // Simulates the user consenting on Google: issues a one-time code bound to the
    // PKCE challenge (if any) in the authorization URL, for a Google address.
    const consent = (launchRes, email) => {
      const code = `gcode-${++codeSeq}-${crypto.randomBytes(4).toString('hex')}`;
      google.issued[code] = { challenge: gUrl(launchRes)?.searchParams.get('code_challenge') || null };
      google.emailFor[`AT-${code}`] = email;
      return code;
    };
    const callback = (q, cookies = {}) => req('GET', `/auth/google/callback?${new URLSearchParams(q)}`, { cookies });
    const handleOf = (r) => { const m = /#gmail_complete=([A-Za-z0-9_-]{43})$/.exec(r.headers.get('location') || ''); return m ? m[1] : null; };
    const preview  = (auth, handle, origin = ORIGIN) => req('POST', '/auth/google/complete/preview', { ...auth, json: { handle }, headers: { Origin: origin } });
    const complete = (auth, handle, confirm = true) => req('POST', '/auth/google/complete', { ...auth, json: { handle, confirm }, headers: { Origin: ORIGIN } });
    const attempt  = (auth) => req('GET', '/auth/google/attempt', auth);
    const gmailRow = (uid) => db.prepare('SELECT * FROM gmail_tokens WHERE user_id = ?').get(uid);
    const errCode  = (r) => { try { return new URL(r.headers.get('location')).searchParams.get('gmail_error'); } catch { return null; } };
    // Runs start → launch (GET, in a separate browser jar with no session) →
    // consent → callback with that jar's nonce, and returns the handle.
    async function toHandle(auth, email, { origin = ORIGIN, via = 'get', callbackCookies = {} } = {}) {
      const s = await start(auth, { origin });
      const t = ticketOf(s);
      const l = via === 'post' ? await launchPost(t) : await launchGet(t);
      const code = consent(l, email);
      const cb = await callback({ state: stateOf(l), code }, { plumbline_goauth: nonceOf(l), ...callbackCookies });
      return { s, t, l, code, cb, handle: handleOf(cb) };
    }
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const secrets = [];   // every secret value seen, for the final log audit
    const remember = (...v) => v.forEach(x => x && secrets.push(String(x)));

    // A1 legacy start is retired: no side effects even with a valid cookie (cross-site <img>/link)
    let r = await req('GET', '/auth/google', cookie(tA));
    ok('A1 legacy GET /auth/google is retired: redirect only, no attempt created, no cookie set',
      r.status === 303 && errCode(r) === 'restart_required' && count('SELECT COUNT(*) n FROM gmail_oauth_flows') === 0 && r.setCookies.length === 0);

    // A2 CSRF: start requires JSON + an app Origin
    const rText = await req('POST', '/auth/google/start', { ...cookie(tA), headers: { 'Content-Type': 'text/plain', Origin: ORIGIN }, form: '{}' });
    const rForeign = await start(cookie(tA), { origin: 'https://evil.example' });
    const rNoOrigin = await start(cookie(tA), { origin: null });
    ok('A2 start refuses simple (text/plain) requests, foreign Origins and missing Origin — nothing created',
      rText.status === 403 && rForeign.status === 403 && rNoOrigin.status === 403 && count('SELECT COUNT(*) n FROM gmail_oauth_flows') === 0);

    // A3 start authentication: never ?token=, no conflicts, no expired/disabled sessions
    const rQ = await req('POST', `/auth/google/start?token=${tA}`, { json: {}, headers: { Origin: ORIGIN } });
    const rConf = await start({ token: tA, cookies: { plumbline_session: tB } });
    const rExp = await start(bearer(mkSession(A, -1000)));
    const tSoonSusp = mkSession(SUSP);
    const rDis = await start(bearer(tSoonSusp));
    ok('A3 start rejects ?token=, cookie/Bearer for different accounts, expired and disabled sessions (401)',
      rQ.status === 401 && rConf.status === 401 && rExp.status === 401 && rDis.status === 401 && rDis.data?.code === 'ACCOUNT_DISABLED'
      && count('SELECT COUNT(*) n FROM gmail_oauth_flows') === 0);

    // A4 start success with Bearer only (Safari: no third-party cookie)
    r = await start(bearer(tA));
    const t1 = ticketOf(r);
    const f1 = lastFlow(A);
    ok('A4 start (Bearer only, Safari-style) returns only a launch URL with a 256-bit single-use ticket on the backend host',
      r.status === 200 && Object.keys(r.data).join() === 'launchUrl' && /^[A-Za-z0-9_-]{43}$/.test(t1 || '')
      && r.data.launchUrl.startsWith(`${BASE_URL}/auth/google/launch?t=`));
    ok('A5 only the ticket hash is stored (no plaintext, no state/nonce yet); responses are no-store + no-referrer',
      f1.ticket_hash === sha(t1) && !JSON.stringify(f1).includes(t1) && !f1.state_hash && !f1.nonce_hash && f1.status === 'started'
      && /no-store/.test(r.headers.get('cache-control') || '') && r.headers.get('referrer-policy') === 'no-referrer');
    remember(t1);

    // A6 launch (GET, a different browser with no session — Android's external browser)
    const l1 = await launchGet(t1);
    const st1 = stateOf(l1), n1 = nonceOf(l1);
    const nCookie = l1.setCookies.find(c => c.startsWith('plumbline_goauth=')) || '';
    const f1b = lastFlow(A);
    ok('A6 launch redirects to Google (state, offline, consent; no PKCE by default) and sets the browser nonce',
      l1.status === 303 && gUrl(l1)?.host === 'accounts.google.com' && /^[A-Za-z0-9_-]{43}$/.test(st1 || '') && /^[A-Za-z0-9_-]{43}$/.test(n1 || '')
      && gUrl(l1).searchParams.get('prompt') === 'consent' && gUrl(l1).searchParams.get('access_type') === 'offline'
      && !gUrl(l1).searchParams.get('code_challenge') && !gUrl(l1).searchParams.get('login_hint'));
    ok('A7 nonce cookie is HttpOnly, SameSite=Lax, Path=/auth/google; only state/nonce hashes stored; ticket burned',
      /HttpOnly/i.test(nCookie) && /SameSite=Lax/i.test(nCookie) && /Path=\/auth\/google/i.test(nCookie)
      && f1b.state_hash === sha(st1) && f1b.nonce_hash === sha(n1) && !f1b.ticket_hash && f1b.status === 'launched' && !JSON.stringify(f1b).includes(st1));
    remember(st1, n1);
    r = await launchGet(t1);
    ok('A8 launch ticket is single-use (replay → state_invalid, no cookie)', errCode(r) === 'state_invalid' && !r.setCookies.some(c => c.startsWith('plumbline_goauth=')));
    r = await launchGet('not-a-ticket');
    const rMissingT = await req('GET', '/auth/google/launch');
    ok('A9 malformed or missing ticket → state_invalid', errCode(r) === 'state_invalid' && errCode(rMissingT) === 'state_invalid');

    // A10 callback parks the result and lands on the app with a fragment handle only
    const code1 = consent(l1, 'a-mailbox@example.test');
    remember(code1, `AT-${code1}`, `RT-${code1}`);
    r = await callback({ state: st1, code: code1 }, { plumbline_goauth: n1 });
    const h1 = handleOf(r);
    const f1c = lastFlow(A);
    ok('A10 callback → 303 to <app>/#gmail_complete=<handle>: no query, no code/state/email in the URL',
      r.status === 303 && !!h1 && (r.headers.get('location') || '') === `${ORIGIN}/#gmail_complete=${h1}`);
    ok('A11 result is parked, not attached: no gmail_tokens row; handle stored as a hash; nonce cookie cleared',
      !gmailRow(A) && f1c.status === 'parked' && f1c.handle_hash === sha(h1) && f1c.google_email === 'a-mailbox@example.test'
      && !f1c.state_hash && !f1c.nonce_hash && r.setCookies.some(c => /^plumbline_goauth=;/.test(c)));
    remember(h1);
    r = await attempt(bearer(tA));
    ok('A12 the app can see progress without any secret: waiting_for_confirmation', r.status === 200 && r.data?.status === 'waiting_for_confirmation' && Object.keys(r.data).join() === 'status');

    // Safari-style completion (Bearer only)
    r = await preview(bearer(tA), h1);
    ok('A13 preview (Bearer only) shows the Google address and does NOT consume the handle',
      r.status === 200 && r.data?.googleEmail === 'a-mailbox@example.test' && lastFlow(A).status === 'parked');
    r = await complete(bearer(tA), h1, true);
    const gA = gmailRow(A);
    ok('A14 explicit confirm by the initiating account connects Gmail for that account only',
      r.status === 200 && r.data?.ok === true && gA?.email === 'a-mailbox@example.test' && gA.refresh_token === `RT-${code1}` && !gmailRow(B));
    const f1d = lastFlow(A);
    ok('A15 parked tokens are wiped from the attempt after completion', f1d.status === 'connected' && !f1d.p_access_token && !f1d.p_refresh_token && !f1d.google_email && !f1d.handle_hash);
    r = await complete(bearer(tA), h1, true);
    const rPrevReplay = await preview(bearer(tA), h1);
    ok('A16 replay of a used handle → 410 state_invalid (complete and preview)', r.status === 410 && r.data?.code === 'state_invalid' && rPrevReplay.status === 410);
    r = await callback({ state: st1, code: code1 }, { plumbline_goauth: n1 });
    ok('A17 replay of a used state → state_invalid', errCode(r) === 'state_invalid');
    ok('A18 attempt status reports connected (from the attempt itself)', (await attempt(bearer(tA))).data?.status === 'connected');

    // A19 desktop: cookie session only, web form-POST launch, callback carries the same session
    clearGmailLimits();
    const dB = await toHandle(cookie(tB), 'b-mailbox@example.test', { via: 'post', callbackCookies: { plumbline_session: tB } });
    remember(dB.t, dB.code, dB.handle, stateOf(dB.l), nonceOf(dB.l));
    const pB = await preview(cookie(tB), dB.handle);
    const cB = await complete(cookie(tB), dB.handle, true);
    ok('A19 desktop (cookie session, form-POST launch so the ticket is not in the URL) connects for the initiator',
      dB.l.status === 303 && pB.data?.googleEmail === 'b-mailbox@example.test' && cB.status === 200 && gmailRow(B)?.email === 'b-mailbox@example.test');
    r = await launchPost(ticketOf(await start(cookie(tB))), 'https://evil.example');
    ok('A20 form-POST launch from a foreign Origin is refused', errCode(r) === 'state_invalid');

    // A21 Android: started in the WebView (Origin https://localhost), finished in the external browser
    clearGmailLimits();
    const wv = await toHandle({ token: tC, headers: {} }, 'c-mailbox@example.test', { origin: 'https://localhost' });
    remember(wv.t, wv.code, wv.handle);
    ok('A21 Android: start from the WebView origin; the external browser (no session) gets the handle on the default app origin',
      wv.s.status === 200 && wv.handle && (wv.cb.headers.get('location') || '').startsWith(`${ORIGIN}/#gmail_complete=`));
    r = await preview({}, wv.handle);
    ok('A22 Android: unsigned-in external browser cannot preview or complete (401) and the handle survives',
      r.status === 401 && (await complete({}, wv.handle)).status === 401 && lastFlow(C).status === 'parked');
    const extLogin = await req('POST', '/auth/login', { json: { email: 'c@example.test', password: PW }, ip: '198.51.100.40' });
    const extTok = extLogin.data?.token;
    r = await preview(bearer(extTok), wv.handle);
    const rWvWait = await attempt(bearer(tC));
    const cC = await complete(bearer(extTok), wv.handle, true);
    await req('POST', '/auth/logout', { token: extTok });
    ok('A23 Android: after signing in as the same account in the browser, preview + confirm connect Gmail; the temporary session is then removed',
      r.data?.googleEmail === 'c-mailbox@example.test' && rWvWait.data?.status === 'waiting_for_confirmation' && cC.status === 200
      && gmailRow(C)?.email === 'c-mailbox@example.test' && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', extTok) === 0);
    ok('A24 Android: the app (WebView session) sees "connected" by polling the attempt status', (await attempt(bearer(tC))).data?.status === 'connected');

    // A25 return origin
    clearGmailLimits();
    const ro = await toHandle(bearer(tA), 'a-mailbox@example.test', { origin: 'https://second.example.test' });
    ok('A25 an allowed non-default app origin gets the result on that same origin', (ro.cb.headers.get('location') || '').startsWith('https://second.example.test/#gmail_complete='));
    await complete(bearer(tA), ro.handle, false);

    // A26-A28 cross-account
    clearGmailLimits();
    const x = await toHandle(bearer(tA), 'a-second@example.test');
    remember(x.handle, x.code);
    r = await preview(bearer(tB), x.handle);
    const stillParked = lastFlow(A).status === 'parked';
    ok('A26 another account\'s preview → 403 account_mismatch without burning the handle', r.status === 403 && r.data?.code === 'account_mismatch' && stillParked);
    const revBeforeX = google.revoked.length;
    r = await complete(bearer(tB), x.handle, true);
    await sleep(30);
    const fx = lastFlow(A);
    ok('A27 another account\'s completion → 403 and the handle is burned; parked tokens wiped; nothing attached to either account',
      r.status === 403 && r.data?.code === 'account_mismatch' && fx.status === 'failed' && fx.failure === 'account_mismatch'
      && !fx.p_access_token && gmailRow(A)?.email === 'a-mailbox@example.test' && gmailRow(B)?.email === 'b-mailbox@example.test');
    ok('A28 rejected tokens are wiped locally and never revoked (a revoke would cancel the Google user\'s whole grant)',
      google.revoked.length === revBeforeX);
    r = await complete(bearer(tA), x.handle, true);
    ok('A29 the initiator cannot complete a burned handle afterwards', r.status === 410);

    // A30 handle injection: initiator signed in, but the result belongs to an attacker's Google
    // address — nothing connects without an explicit confirm that names that address.
    clearGmailLimits();
    const inj = await toHandle(bearer(tB), 'attacker-mailbox@example.test');
    r = await preview(bearer(tB), inj.handle);
    ok('A30 injected result is never connected silently: preview names the Google address and the row is unchanged until confirm',
      r.data?.googleEmail === 'attacker-mailbox@example.test' && gmailRow(B)?.email === 'b-mailbox@example.test');
    await complete(bearer(tB), inj.handle, false);
    ok('A31 Cancel burns the result and keeps the existing connection', gmailRow(B)?.email === 'b-mailbox@example.test'
      && lastFlow(B).failure === 'cancelled' && !lastFlow(B).p_access_token && (await attempt(bearer(tB))).data?.reason === 'cancelled');

    // A32 browser swap: the Google URL from A's launch is consented in another browser
    clearGmailLimits();
    const sw = await start(bearer(tA));
    const swl = await launchGet(ticketOf(sw));
    const swCode = consent(swl, 'victim-mailbox@example.test');
    const tokCalls0 = google.getTokenCalls;
    r = await callback({ state: stateOf(swl), code: swCode }, {});               // no nonce
    await sleep(20);
    ok('A32 browser swap (no nonce) → state_invalid; nothing parked', errCode(r) === 'state_invalid' && lastFlow(A).failure === 'browser_mismatch' && !lastFlow(A).p_access_token);
    ok('A33 without PKCE the stranded code is redeemed once and discarded (cannot be injected later)', google.getTokenCalls === tokCalls0 + 1 && google.used.has(swCode));
    // Attacker injects that code into their own valid flow
    const atk = await start(bearer(tC));
    const atkL = await launchGet(ticketOf(atk));
    r = await callback({ state: stateOf(atkL), code: swCode }, { plumbline_goauth: nonceOf(atkL) });
    ok('A34 code injection into another flow fails (code already used) → callback_failed, nothing parked',
      errCode(r) === 'callback_failed' && lastFlow(C).status === 'failed' && !lastFlow(C).p_access_token);
    r = await callback({ state: stateOf(swl), code: swCode }, { plumbline_goauth: nonceOf(swl) });
    ok('A35 a state burned by a failed browser check cannot be retried', errCode(r) === 'state_invalid');

    // A36 PKCE mode
    clearGmailLimits();
    process.env.GMAIL_OAUTH_PKCE = 'true';
    const pk = await start(bearer(tA));
    const pkl = await launchGet(ticketOf(pk));
    const pkUrl = gUrl(pkl);
    const pkCode = consent(pkl, 'a-pkce@example.test');
    r = await callback({ state: stateOf(pkl), code: pkCode }, { plumbline_goauth: nonceOf(pkl) });
    ok('A36 PKCE mode: S256 challenge sent; the verifier is used at the exchange and wiped; success parks the result',
      pkUrl.searchParams.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(pkUrl.searchParams.get('code_challenge') || '')
      && !!handleOf(r) && google.lastVerifier && !lastFlow(A).pkce_verifier);
    await complete(bearer(tA), handleOf(r), false);
    const pa = await start(bearer(tA)); const pal = await launchGet(ticketOf(pa));
    const pb = await start(bearer(tB)); const pbl = await launchGet(ticketOf(pb));
    const codeForA = consent(pal, 'victim2@example.test');
    const tc1 = google.getTokenCalls;
    r = await callback({ state: stateOf(pbl), code: codeForA }, { plumbline_goauth: nonceOf(pbl) });
    ok('A37 PKCE mode: a code issued for one flow is rejected on another (verifier mismatch) → callback_failed',
      errCode(r) === 'callback_failed' && google.getTokenCalls === tc1 + 1 && !lastFlow(B).p_access_token);
    const tc2 = google.getTokenCalls;
    await callback({ state: stateOf(pal), code: 'x' }, {});
    await sleep(20);
    ok('A38 PKCE mode: a failed browser check does not call Google (the code is bound to the wiped verifier)', google.getTokenCalls === tc2);
    delete process.env.GMAIL_OAUTH_PKCE;

    // A39-A42 interrupted flows
    clearGmailLimits();
    const iu = await start(bearer(tA));
    db.prepare("UPDATE gmail_oauth_flows SET ticket_expires = ? WHERE ticket_hash = ?").run(new Date(Date.now() - 1000).toISOString(), sha(ticketOf(iu)));
    r = await launchGet(ticketOf(iu));
    ok('A39 an unlaunched ticket expires after 2 minutes', errCode(r) === 'state_invalid');
    const il = await start(bearer(tA)); const ill = await launchGet(ticketOf(il));
    db.prepare("UPDATE gmail_oauth_flows SET flow_expires = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), lastFlow(A).id);
    r = await callback({ state: stateOf(ill), code: consent(ill, 'late@example.test') }, { plumbline_goauth: nonceOf(ill) });
    ok('A40 a callback after the 10-minute window → state_invalid', errCode(r) === 'state_invalid');
    const ip = await toHandle(bearer(tA), 'a-abandoned@example.test');
    db.prepare("UPDATE gmail_oauth_flows SET handle_expires = ? WHERE handle_hash = ?").run(new Date(Date.now() - 1000).toISOString(), sha(ip.handle));
    r = await complete(bearer(tA), ip.handle, true);
    const revBeforeExp = google.revoked.length;
    const wiped = authRouter.expireGmailFlows();
    await sleep(30);
    const fip = db.prepare('SELECT * FROM gmail_oauth_flows WHERE id = (SELECT MAX(id) FROM gmail_oauth_flows WHERE user_id = ?)').get(A);
    ok('A41 an unclaimed result expires after 10 minutes: completion refused; the sweep wipes the tokens (no revoke)',
      r.status === 410 && wiped >= 1 && fip.status === 'expired' && !fip.p_access_token && !fip.p_refresh_token && google.revoked.length === revBeforeExp);
    ok('A42 the app sees "expired" for an abandoned attempt', (await attempt(bearer(tA))).data?.status === 'expired');

    // A43 supersede rules
    clearGmailLimits();
    const s1 = await start(bearer(tA)); const s2 = await start(bearer(tA));
    r = await launchGet(ticketOf(s1));
    ok('A43 a new start supersedes the account\'s unlaunched attempt (old ticket no longer launches)', errCode(r) === 'state_invalid'
      && db.prepare("SELECT COUNT(*) n FROM gmail_oauth_flows WHERE user_id = ? AND failure = 'superseded'").get(A).n >= 1);
    await launchGet(ticketOf(s2));
    const pk1 = await toHandle(bearer(tA), 'a-p1@example.test');
    await start(bearer(tA));
    ok('A44 a new start never touches a parked result', db.prepare('SELECT status FROM gmail_oauth_flows WHERE handle_hash = ?').get(sha(pk1.handle))?.status === 'parked');
    const pk2 = await toHandle(bearer(tA), 'a-p2@example.test');
    const pk3 = await toHandle(bearer(tA), 'a-p3@example.test');
    r = await start(bearer(tA));
    ok('A45 start is refused while 3 results are waiting to be claimed', r.status === 429 && r.data?.code === 'too_many_attempts');
    r = await complete(bearer(tA), pk2.handle, true);
    ok('A46 completing one result wipes the account\'s other parked results', r.status === 200
      && ['parked'].indexOf(db.prepare('SELECT status FROM gmail_oauth_flows WHERE handle_hash IS NULL AND google_email IS NULL AND user_id = ? ORDER BY id DESC LIMIT 1').get(A)?.status) === -1
      && db.prepare("SELECT COUNT(*) n FROM gmail_oauth_flows WHERE user_id = ? AND status = 'parked'").get(A).n === 0
      && (await complete(bearer(tA), pk1.handle, true)).status === 410 && (await complete(bearer(tA), pk3.handle, true)).status === 410);

    // A47-A48 address change replaces the whole token set
    clearGmailLimits();
    ok('A47 switching Gmail address stores the NEW refresh token (never pairs a new address with an old token)',
      gmailRow(A)?.email === 'a-p2@example.test' && gmailRow(A).refresh_token === `RT-${pk2.code}`);
    google.noRefresh = true;
    const nr = await toHandle(bearer(tA), 'a-different@example.test');
    r = await complete(bearer(tA), nr.handle, true);
    const nrSame = await toHandle(bearer(tA), 'a-p2@example.test');
    const rSame = await complete(bearer(tA), nrSame.handle, true);
    google.noRefresh = false;
    ok('A48 a different address without a refresh token is refused; the same address keeps its refresh token',
      r.status === 502 && rSame.status === 200 && gmailRow(A).email === 'a-p2@example.test' && gmailRow(A).refresh_token === `RT-${pk2.code}`);

    // A49 Google outcomes
    clearGmailLimits();
    const ms = await start(bearer(tA)); const msl = await launchGet(ticketOf(ms));
    google.nextScope = 'https://www.googleapis.com/auth/userinfo.email';
    const revMs = google.revoked.length;
    r = await callback({ state: stateOf(msl), code: consent(msl, 'b-mailbox@example.test') }, { plumbline_goauth: nonceOf(msl) });
    google.nextScope = null;
    await sleep(20);
    ok('A49 missing Gmail scopes → missing_scopes; tokens dropped, never stored or revoked',
      errCode(r) === 'missing_scopes' && google.revoked.length === revMs && !lastFlow(A).p_access_token);
    const ad = await start(bearer(tA)); const adl = await launchGet(ticketOf(ad));
    r = await callback({ state: stateOf(adl), error: 'access_denied' }, { plumbline_goauth: nonceOf(adl) });
    const oe = await start(bearer(tA)); const oel = await launchGet(ticketOf(oe));
    const rEcho = await callback({ state: stateOf(oel), error: 'server_error<ECHO-PROBE>' }, { plumbline_goauth: nonceOf(oel) });
    ok('A50 Google errors map to generic codes; the raw value is never logged or echoed',
      errCode(r) === 'access_restricted' && errCode(rEcho) === 'oauth_error' && !logged.some(l => l.includes('ECHO-PROBE')) && !String(rEcho.headers.get('location')).includes('ECHO-PROBE'));
    const bm = await start(bearer(tA)); const bml = await launchGet(ticketOf(bm));
    r = await callback({ state: stateOf(bml), code: 'boom' }, { plumbline_goauth: nonceOf(bml) });
    ok('A51 token-exchange failure → callback_failed; error text never logged', errCode(r) === 'callback_failed' && !logged.some(l => l.includes('SECRET-boom') || l.includes('code=boom')));

    // A52-A54 account state during the flow
    clearGmailLimits();
    const later = mkUser('later-suspended@example.test');
    const tLater = mkSession(later);
    const ls = await start(bearer(tLater));
    db.prepare('UPDATE users SET is_suspended = 1 WHERE id = ?').run(later);
    r = await launchGet(ticketOf(ls));
    ok('A52 account suspended between start and launch → launch refused', errCode(r) === 'state_invalid');
    db.prepare('UPDATE users SET is_suspended = 0 WHERE id = ?').run(later);
    const tLater2 = mkSession(later);
    const lh = await toHandle(bearer(tLater2), 'later@example.test');
    db.prepare("UPDATE users SET access_status = 'blocked' WHERE id = ?").run(later);
    r = await complete(bearer(tLater2), lh.handle, true);
    ok('A53 account blocked before completion → 401 ACCOUNT_DISABLED, nothing connected', r.status === 401 && r.data?.code === 'ACCOUNT_DISABLED' && !gmailRow(later));
    const mm = await start(bearer(tA)); const mml = await launchGet(ticketOf(mm));
    r = await callback({ state: stateOf(mml), code: consent(mml, 'x@example.test') }, { plumbline_goauth: nonceOf(mml), plumbline_session: tC });
    ok('A54 callback in a browser signed in as a different account → rejected with its own code (clear "sign out there" guidance)',
      errCode(r) === 'signed_in_other_account' && lastFlow(A).failure === 'signed_in_other_account');
    const at54 = await attempt(bearer(tA));
    ok('A54b the app sees the same specific reason', at54.data?.status === 'failed' && at54.data?.reason === 'signed_in_other_account');

    // A54c-e nonce cookie hygiene: a stale tab or a cross-site link cannot kill the live attempt
    clearGmailLimits();
    const o1 = await start(bearer(tA)); const o1l = await launchGet(ticketOf(o1));
    const o2 = await start(bearer(tA)); const o2l = await launchGet(ticketOf(o2));          // supersedes o1 in the same browser
    const liveNonce = nonceOf(o2l);
    r = await callback({ state: stateOf(o1l), code: consent(o1l, 'a-mailbox@example.test') }, { plumbline_goauth: liveNonce });
    ok('A54c a stale tab\'s callback is rejected WITHOUT clearing the browser\'s current nonce cookie',
      errCode(r) === 'state_invalid' && !r.setCookies.some(c => c.startsWith('plumbline_goauth=')));
    const rX = await callback({ state: 'x' }, { plumbline_goauth: liveNonce });
    ok('A54d a cross-site navigation to the callback does not clear it either', !rX.setCookies.some(c => c.startsWith('plumbline_goauth=')));
    r = await callback({ state: stateOf(o2l), code: consent(o2l, 'a-mailbox@example.test') }, { plumbline_goauth: liveNonce });
    ok('A54e the live attempt still completes its callback afterwards (cookie cleared only now)',
      !!handleOf(r) && r.setCookies.some(c => /^plumbline_goauth=;/.test(c)));
    await complete(bearer(tA), handleOf(r), false);

    // A54f-g the sweep is never on the request path; status is computed per row
    clearGmailLimits();
    const sw2 = await toHandle(bearer(tA), 'a-sweep@example.test');
    db.prepare('UPDATE gmail_oauth_flows SET handle_expires = ? WHERE handle_hash = ?').run(new Date(Date.now() - 1000).toISOString(), sha(sw2.handle));
    const atSw = await attempt(bearer(tA));
    await start(bearer(tB));
    const rowSw = db.prepare('SELECT status, p_access_token FROM gmail_oauth_flows WHERE handle_hash = ?').get(sha(sw2.handle));
    ok('A54f /attempt reports "expired" for its own row while /attempt and /start leave the wiping to the timed sweep',
      atSw.data?.status === 'expired' && rowSw?.status === 'parked' && !!rowSw.p_access_token);
    authRouter.expireGmailFlows();
    ok('A54g the timed sweep then wipes it', !db.prepare('SELECT p_access_token FROM gmail_oauth_flows WHERE id = (SELECT MAX(id) FROM gmail_oauth_flows WHERE user_id = ? AND google_email IS NULL AND status = ?)').get(A, 'expired')?.p_access_token
      && count("SELECT COUNT(*) n FROM gmail_oauth_flows WHERE status = 'parked' AND handle_expires <= ?", new Date().toISOString()) === 0);
    const plans = [
      "SELECT 1 FROM gmail_oauth_flows WHERE status = 'parked' AND handle_expires <= '2026-01-01'",
      "SELECT 1 FROM gmail_oauth_flows WHERE status IN ('started','launched') AND flow_expires <= '2026-01-01'",
      "SELECT 1 FROM gmail_oauth_flows WHERE created_at <= '2026-01-01'",
    ].map(q => db.prepare('EXPLAIN QUERY PLAN ' + q).all().map(x => x.detail).join(' '));
    ok('A54h the sweep\'s predicates use indexes (no full scans)', plans.every(pl => /USING (COVERING )?INDEX/.test(pl)), plans.join(' | '));

    // A55 rate limits
    clearGmailLimits();
    let lastS = null;
    for (let i = 0; i < 11; i++) lastS = await start(bearer(tB));
    ok('A55 starts are limited per account (10 per 10 minutes)', lastS.status === 429 && lastS.data?.code === 'too_many_attempts');
    clearGmailLimits();
    let lastP = null;
    for (let i = 0; i < 21; i++) lastP = await preview(bearer(tB), crypto.randomBytes(32).toString('base64url'));
    ok('A56 preview/complete attempts are limited per account', lastP.status === 429);
    clearGmailLimits();

    // A57 disabled feature
    process.env.GMAIL_OAUTH_ENABLED = 'false';
    const ds = await start(bearer(tA));
    const dl = await launchGet(crypto.randomBytes(32).toString('base64url'));
    const dc = await callback({ state: crypto.randomBytes(32).toString('base64url'), code: 'c' });
    process.env.GMAIL_OAUTH_ENABLED = 'true';
    ok('A57 with Gmail OAuth disabled: start 403 oauth_disabled; launch/callback redirect oauth_disabled',
      ds.status === 403 && ds.data?.code === 'oauth_disabled' && errCode(dl) === 'oauth_disabled' && errCode(dc) === 'oauth_disabled');

    // A58-A59 disconnect
    const revD = google.revoked.length;
    r = await req('DELETE', '/auth/gmail-disconnect', { token: tC });
    await sleep(30);
    ok('A58 disconnect deletes only own tokens and revokes via a body POST', r.status === 200 && !gmailRow(C) && !!gmailRow(A) && google.revoked.length === revD + 1
      && google.revokeRequests[google.revokeRequests.length - 1].body === `token=RT-${wv.code}`);
    db.prepare("INSERT INTO gmail_tokens (email, access_token, refresh_token, user_id) VALUES ('shared@example.test', 'AT-s1', 'RT-s1', ?)").run(C);
    db.prepare("UPDATE gmail_tokens SET email = 'shared@example.test' WHERE user_id = ?").run(B);
    const revS = google.revoked.length;
    await req('DELETE', '/auth/gmail-disconnect', { token: tC });
    await sleep(30);
    ok('A59 disconnect skips the Google revoke when another account uses the same Gmail address', !gmailRow(C) && !!gmailRow(B) && google.revoked.length === revS);
    r = await req('GET', `/auth/gmail-status?token=${tA}`);
    ok('A60 Gmail endpoints never accept a session token in the URL', r.status === 401);

    // A61 user deletion with attempts on record
    const gone = mkUser('deleted-initiator@example.test');
    await start(bearer(mkSession(gone)));
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(gone);
    let delErr = null;
    try { db.prepare('DELETE FROM users WHERE id = ?').run(gone); } catch (e) { delErr = e.message; }
    ok('A61 deleting a user with Gmail attempts works (ON DELETE CASCADE)', delErr === null && count('SELECT COUNT(*) n FROM gmail_oauth_flows WHERE user_id = ?', gone) === 0, delErr || '');

    // A62 headers
    const hs = await start(bearer(tA)); const hl = await launchGet(ticketOf(hs));
    const hc = await callback({ state: stateOf(hl), error: 'access_denied' }, { plumbline_goauth: nonceOf(hl) });
    const hp = await preview(bearer(tA), crypto.randomBytes(32).toString('base64url'));
    const ha = await attempt(bearer(tA));
    ok('A62 every OAuth response is no-store + no-referrer', [hs, hl, hc, hp, ha].every(x => /no-store/.test(x.headers.get('cache-control') || '') && x.headers.get('referrer-policy') === 'no-referrer'));
    ok('A63 a fresh OAuth client per request (no shared client)', google.instances >= 20, `instances=${google.instances}`);

    // A64 Sentry scrubbing (backend)
    const { scrubEvent } = require(path.join(BE, 'utils/sentryScrub'));
    const ev = scrubEvent({ request: { url: `${BASE_URL}/auth/google/callback?code=SECRETCODE&state=S#frag`, cookies: { plumbline_session: tA }, headers: { authorization: `Bearer ${tA}` }, data: '{"handle":"H"}', query_string: 'code=SECRETCODE' },
      breadcrumbs: [{ data: { url: 'https://oauth2.googleapis.com/revoke?token=RTX', 'http.query': '?token=RTX' } }],
      spans: [{ description: `GET ${BASE_URL}/auth/google/launch?t=TICKETX`, data: { 'http.url': `${BASE_URL}/x?t=TICKETX`, 'url.query': 't=TICKETX' } }] });
    ok('A64 backend Sentry events carry no cookies, headers, bodies, query strings or fragments', !/SECRETCODE|TICKETX|RTX|Bearer|"H"|#frag/.test(JSON.stringify(ev)) && !JSON.stringify(ev).includes(tA));
    const { scrubBreadcrumb } = require(path.join(BE, 'utils/sentryScrub'));
    const ev2 = scrubEvent({ breadcrumbs: [{ category: 'console', message: '[Poller] stored from jane@example.test' }, { category: 'http', data: { url: 'https://x/y?token=Z' } }] });
    ok('A64b console log text never reaches Sentry breadcrumbs', scrubBreadcrumb({ category: 'console', message: 'x@example.test' }) === null
      && ev2.breadcrumbs.length === 1 && !JSON.stringify(ev2).includes('jane@') && !JSON.stringify(ev2).includes('token=Z'));

    // A65 log audit across the whole section
    const leaked = secrets.filter(s => s.length > 6 && logged.some(l => l.includes(s)));
    const emailsLogged = logged.filter(l => /mailbox@example\.test|@example\.test/.test(l) && /Gmail OAuth|Backfill|Poller/.test(l));
    ok('A65 no ticket, state, nonce, handle, code, token or Google address appears in any log line', leaked.length === 0 && emailsLogged.length === 0, `${leaked.length} leaked, ${emailsLogged.length} emails`);

    // ── B. Suspension and session expiry ────────────────────────────────────
    r = await req('POST', '/auth/login', { json: { email: 'suspended@example.test', password: PW }, ip: '198.51.100.1' });
    ok('B1 suspended user with correct password → 403 ACCOUNT_DISABLED, no session', r.status === 403 && r.data?.code === 'ACCOUNT_DISABLED' && count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND julianday(expires_at) > julianday('now')", SUSP) === 0);
    r = await req('POST', '/auth/login', { json: { email: 'suspended@example.test', password: 'wrong' }, ip: '198.51.100.1' });
    ok('B2 suspended user with wrong password → generic 401 (status not revealed)', r.status === 401 && r.data?.error === 'Invalid email or password');
    r = await req('POST', '/auth/login', { json: { email: 'c@example.test', password: PW }, ip: '198.51.100.2' });
    const cTok = r.data?.token;
    ok('B3 active user login still works', r.status === 200 && !!cTok && (await req('GET', '/api/whoami', { token: cTok })).data?.userId === C);
    db.prepare('UPDATE users SET is_suspended = 1 WHERE id = ?').run(C);
    r = await req('GET', '/api/whoami', { token: cTok });
    ok('B4 open session stops working after suspension (401 ACCOUNT_DISABLED)', r.status === 401 && r.data?.code === 'ACCOUNT_DISABLED');
    ok('B5 all of the suspended user\'s sessions are ended (none can authenticate)', count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND julianday(expires_at) > julianday('now')", C) === 0);
    const cTok2 = mkSession(C);
    r = await req('GET', '/auth/me', { token: cTok2 });
    ok('B6 /auth/me rejects a suspended account and removes its sessions', r.status === 401 && r.data?.code === 'ACCOUNT_DISABLED' && count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND julianday(expires_at) > julianday('now')", C) === 0);
    db.prepare('UPDATE users SET is_suspended = 0 WHERE id = ?').run(C);

    const live = mkSession(A, 2000), dead = mkSession(A, -2000);
    ok('B7 session valid 2 s before expiry', (await req('GET', '/api/whoami', { token: live })).status === 200);
    ok('B8 session rejected 2 s after expiry', (await req('GET', '/api/whoami', { token: dead })).status === 401);
    const sameDay = crypto.randomBytes(16).toString('hex');
    const earlier = new Date(Date.now() - 60e3);
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(sameDay, A, earlier.toISOString());
    ok('B9 expired earlier the same UTC day → rejected (old text-compare bug)', (await req('GET', '/api/whoami', { token: sameDay })).status === 401 && (await req('GET', '/auth/me', { token: sameDay })).status === 401);
    const spaceFmt = crypto.randomBytes(16).toString('hex');
    db.prepare("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,datetime('now','+1 hour'))").run(spaceFmt, A);
    ok('B10 legacy "YYYY-MM-DD HH:MM:SS" (UTC) expiry still honoured', (await req('GET', '/api/whoami', { token: spaceFmt })).status === 200);
    const garbage = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(garbage, A, 'not-a-date');
    ok('B11 unparseable expiry fails closed', (await req('GET', '/api/whoami', { token: garbage })).status === 401);

    const sig = (p, params) => twilio.getExpectedTwilioSignature(AUTH_TOKEN, BASE_URL + p, params);
    const vc = { From: `client:user_${SUSP}`, To: '+15557778888', CallSid: 'CA' + '3'.repeat(32) };
    r = await req('POST', '/api/twilio/voice-client', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig('/api/twilio/voice-client', vc) }, form: new URLSearchParams(vc).toString() });
    ok('B12 outbound call from a suspended account is refused (no Dial)', r.status === 200 && /not active/i.test(r.text) && !/<Dial/i.test(r.text));

    // ── C. Rate limits ──────────────────────────────────────────────────────
    // Limiters use fixed windows with a weighted previous window; a run that
    // straddles a window boundary can see ±1 attempt. Start well clear of one.
    { const W = 15 * 60e3, left = W - (Date.now() % W); if (left < 240e3) await new Promise(res => setTimeout(res, left + 1000)); }
    Object.values(authRouter.loginLimits).forEach(l => l.clear()); authRouter.knownLoginIps.clear();
    const login = (email, password, ip) => req('POST', '/auth/login', { json: { email, password }, ip });
    for (let i = 0; i < 5; i++) await login('a@example.test', 'wrong', '203.0.113.1');
    r = await login('a@example.test', PW, '203.0.113.1');
    ok('C1 5 failures for one email+IP → 6th attempt throttled (429 + Retry-After)', r.status === 429 && Number(r.headers.get('retry-after')) > 0);
    for (let i = 0; i < 5; i++) await login('nobody@example.test', 'wrong', '203.0.113.9');
    const rUnknown = await login('nobody@example.test', 'wrong', '203.0.113.9');
    ok('C2 throttle response identical for unknown and existing emails', rUnknown.status === 429 && rUnknown.text === r.text);
    r = await login('a@example.test', PW, '203.0.113.2');
    ok('C3 same email from another IP is not locked out', r.status === 200);
    r = await login('b@example.test', PW, '203.0.113.1');
    ok('C4 another user from the same IP is not locked out', r.status === 200);
    for (let i = 0; i < 4; i++) await login('b@example.test', 'wrong', '203.0.113.3');
    await login('b@example.test', PW, '203.0.113.3');
    for (let i = 0; i < 4; i++) await login('b@example.test', 'wrong', '203.0.113.3');
    r = await login('b@example.test', PW, '203.0.113.3');
    ok('C5 a successful login resets that email+IP failure count', r.status === 200);
    for (let i = 0; i < 20; i++) await login(`spray${i}@example.test`, 'wrong', '203.0.113.50');
    r = await login('owner@example.test', PW, '203.0.113.50');
    ok('C6 per-IP failure cap stops password spraying from one IP', r.status === 429);
    r = await login('owner@example.test', PW, '203.0.113.51');
    ok('C7 other IPs unaffected by one IP being throttled', r.status === 200);
    r = await req('POST', '/auth/login', { json: { email: 1, password: 'x' }, ip: '203.0.113.60' });
    const r2 = await req('POST', '/auth/login', { json: { email: ['a'], password: {} }, ip: '203.0.113.60' });
    ok('C8 non-string credentials → 400 (no crash)', r.status === 400 && r2.status === 400);
    // Real accounts use cost-12 hashes; compare against one so timing parity is meaningful.
    db.prepare('INSERT INTO users (email, display_name, password_hash) VALUES (?,?,?)').run('cost12@example.test', 'c12', bcrypt.hashSync(PW, 12));
    let t0 = Date.now(); await login('ghost@example.test', 'wrong', '203.0.113.70'); const tUnknown = Date.now() - t0;
    t0 = Date.now(); await login('cost12@example.test', 'wrong', '203.0.113.71'); const tKnown = Date.now() - t0;
    ok('C9 unknown-email and wrong-password take similar time (no account oracle)', tUnknown >= tKnown * 0.5 && tUnknown <= tKnown * 2, `unknown=${tUnknown}ms known=${tKnown}ms`);

    const fake = { t: 1_000_000 };
    const lim = createLimiter({ name: 'unit', windowMs: 1000, max: 3, maxKeys: 2, now: () => fake.t });
    lim.hit('k'); lim.hit('k'); lim.hit('k');
    const blocked = lim.check('k') > 0;
    fake.t += 2000;
    ok('C10 limiter blocks at max and recovers after the window', blocked && lim.check('k') === 0);
    lim.hit('x'); lim.hit('y'); lim.hit('z');
    ok('C11 limiter memory is bounded (LRU maxKeys)', lim.size() <= 2);

    const prevNodeEnv = process.env.NODE_ENV, prevTrust = process.env.TRUST_CF_CONNECTING_IP;
    process.env.NODE_ENV = 'production'; delete process.env.TRUST_CF_CONNECTING_IP;
    const k1 = clientIpKey({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.1' } });
    const k2 = clientIpKey({ headers: { 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' }, socket: {} });
    process.env.NODE_ENV = prevNodeEnv ?? ''; if (!prevNodeEnv) delete process.env.NODE_ENV; process.env.TRUST_CF_CONNECTING_IP = prevTrust;
    ok('C12 production IP key ignores spoofable X-Forwarded-For / proxy socket (null → per-IP limits skipped)', k1 === null);
    ok('C13 IPv6 client keys are grouped by /64', k2 === '2001:db8:1:2::/64', String(k2));

    const audio = () => { const f = new FormData(); f.append('audio', new Blob([Buffer.from('fake')], { type: 'audio/mpeg' }), 'a.mp3'); return f; };
    const tA2 = mkSession(A), tB2 = mkSession(B);
    let okCount = 0;
    for (let i = 0; i < 10; i++) if ((await req('POST', '/api/transcribe', { token: tA2, form: audio() })).status === 201) okCount++;
    const w0 = whisperCalls;
    r = await req('POST', '/api/transcribe', { token: tA2, form: audio() });
    ok('C14 transcription: 10/hour per account, 11th → 429 with no paid call', okCount === 10 && r.status === 429 && whisperCalls === w0 && /limit reached/i.test(r.data?.error || ''));
    r = await req('POST', '/api/transcribe', { token: tB2, form: audio() });
    ok('C15 another account is not affected by A\'s transcription limit', r.status === 201);
    transcribe.transcribeLimits.accountHour.clear(); transcribe.transcribeLimits.accountDay.clear();
    for (let i = 0; i < 200; i++) transcribe.transcribeLimits.globalDay.hit('all');
    r = await req('POST', '/api/transcribe', { token: mkSession(C), form: audio() });
    ok('C16 global daily transcription ceiling applies across accounts', r.status === 429);

    // Per-email cap across IPs (distributed guessing) with known-IP exemption.
    Object.values(authRouter.loginLimits).forEach(l => l.clear()); authRouter.knownLoginIps.clear();
    await login('b@example.test', PW, '192.0.2.200');                      // B signs in from home once
    for (let ip = 1; ip <= 4; ip++) for (let i = 0; i < 5; i++) await login('b@example.test', 'wrong', `192.0.2.${ip}`);
    r = await login('b@example.test', PW, '192.0.2.99');
    ok('C17 per-email cap across IPs blocks a new IP after 20 distributed failures', r.status === 429);
    r = await login('b@example.test', PW, '192.0.2.200');
    ok('C18 the account holder\'s known sign-in IP is exempt (no targeted lockout)', r.status === 200);

    // IPv6 /48 tier against /64 rotation.
    Object.values(authRouter.loginLimits).forEach(l => l.clear());
    for (let i = 0; i < 100; i++) await login(`v6spray${i}@example.test`, 'wrong', `2001:db8:abcd:${(i + 1).toString(16)}::1`);
    r = await login('a@example.test', PW, '2001:db8:abcd:ffff::1');
    const rOther48 = await login('a@example.test', PW, '2001:db8:beef:1::1');
    ok('C19 rotating IPv6 /64s inside one /48 is capped at the /48 tier; other /48s unaffected', r.status === 429 && rOther48.status === 200);

    Object.values(authRouter.loginLimits).forEach(l => l.clear());
    let last = null;
    for (let i = 0; i < 51; i++) last = await login(i % 2 ? 'a@example.test' : 'b@example.test', PW, '192.0.2.150');
    ok('C20 per-IP attempt cap (50 / 15 min) applies even to successful logins', last.status === 429);
    Object.values(authRouter.loginLimits).forEach(l => l.clear());
    r = await login('x'.repeat(251) + '@e.t', PW, '192.0.2.151');
    const r20 = await login('a@example.test', 'p'.repeat(1025), '192.0.2.151');
    ok('C21 oversized email / password rejected with 400', r.status === 400 && r20.status === 400);

    // Transcription daily per-account cap and global counter via real requests.
    Object.values(transcribe.transcribeLimits).forEach(l => l.clear());
    const tDay = mkSession(B);
    let dayOk = 0;
    for (let i = 0; i < 40; i++) { if ((await req('POST', '/api/transcribe', { token: tDay, form: audio() })).status === 201) dayOk++; if (i % 10 === 9) transcribe.transcribeLimits.accountHour.clear(); }
    r = await req('POST', '/api/transcribe', { token: tDay, form: audio() });
    ok('C22 40 per day per account; the 41st is refused', dayOk === 40 && r.status === 429);
    ok('C23 every accepted transcription counts toward the global ceiling', transcribe.transcribeLimits.globalDay.check('all') === 0 && (() => { let n = 0; while (!transcribe.transcribeLimits.globalDay.hit('probe') && n < 500) n++; return true; })());
    Object.values(transcribe.transcribeLimits).forEach(l => l.clear());
    const tLeads = mkSession(C);
    for (let i = 0; i < 10; i++) await req('POST', '/api/transcribe', { token: tLeads, form: audio() });
    r = await req('POST', '/api/leads', { token: tLeads, json: { transcript: 'Need a plumber' } });
    ok('C24 manual transcripts (POST /api/leads) share the same paid-AI budget', r.status === 429);
    Object.values(transcribe.transcribeLimits).forEach(l => l.clear());
    r = await req('POST', '/api/leads', { token: tLeads, json: { transcript: 'z'.repeat(20001) } });
    ok('C25 oversized manual transcript rejected before any AI call', r.status === 413);

    // ── D. Push identifier validation ───────────────────────────────────────
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const P256 = ecdh.getPublicKey().toString('base64url');
    const AUTHK = crypto.randomBytes(16).toString('base64url');
    const tD = mkSession(A);
    const sub = (endpoint, keys = { p256dh: P256, auth: AUTHK }) => req('POST', '/api/push/subscribe', { token: tD, json: { endpoint, keys } });
    const good = [
      'https://fcm.googleapis.com/fcm/send/abc:APA91b-xyz',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
      'https://web.push.apple.com/QGuQyavXutnMH8',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAC',
    ];
    const goodRes = [];
    for (const g of good) goodRes.push((await sub(g)).status);
    ok('D1 real browser push endpoints (Chrome, Firefox, Safari, Edge) accepted', goodRes.every(s => s === 200), goodRes.join(','));
    const MARK = 'ZZMARKERZZ';
    const bad = [
      `http://fcm.googleapis.com/fcm/send/${MARK}`, `https://10.0.0.5/${MARK}`, `https://localhost/${MARK}`,
      `https://127.0.0.1:8443/${MARK}`, `https://user:pw@fcm.googleapis.com/${MARK}`, `https://fcm.googleapis.com:8443/${MARK}`,
      `https://evil.example/${MARK}`, `https://fcm.googleapis.com.evil.example/${MARK}`, `https://push.apple.com.evil.example/${MARK}`,
      `https://FCM.googleapis.com/${MARK}`, `https://fcm.googleapis.com/${MARK}#frag`, `https://fcm.googleapis.com/${'a'.repeat(5000)}${MARK}`,
      12345, [`https://fcm.googleapis.com/${MARK}`], { url: MARK }, '',
    ];
    const badRes = [];
    for (const b of bad) badRes.push(await sub(b));
    ok('D2 malformed/hostile/oversized endpoints rejected (400)', badRes.every(x => x.status === 400), badRes.map(x => x.status).join(','));
    ok('D3 rejection body is fixed and never echoes input', badRes.every(x => x.text === '{"error":"Invalid push subscription"}'));
    const keyRes = [
      await sub(good[0], { p256dh: P256.slice(0, 80), auth: AUTHK }),
      await sub(good[0], { p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'), auth: AUTHK }),
      await sub(good[0], { p256dh: P256, auth: 'short' }),
      await sub(good[0], { p256dh: 7, auth: AUTHK }),
    ];
    ok('D4 bad keys rejected (length, off-curve point, auth size, type)', keyRes.every(x => x.status === 400), keyRes.map(x => x.status).join(','));
    const fcm = (t) => req('POST', '/api/push/fcm-subscribe', { token: tD, json: { fcmToken: t } });
    const goodTok = 'cAbCdEfGhIjKlMnOpQrStU:APA91bH' + 'x'.repeat(130);
    ok('D5 valid FCM token accepted', (await fcm(goodTok)).status === 200);
    const fcmBad = [];
    for (const t of ['short', 'a'.repeat(5000), `<script>${MARK}</script>`.padEnd(40, 'x'), 42, null, ['x'.repeat(40)]]) fcmBad.push(await fcm(t));
    ok('D6 malformed/oversized FCM tokens rejected with a fixed body', fcmBad.every(x => x.status === 400 && x.text === '{"error":"Invalid FCM token"}'), fcmBad.map(x => x.status).join(','));
    ok('D7 rejected values never written to logs', !logged.some(l => l.includes(MARK)));
    ok('D8 nothing invalid was stored', count('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', A) === 4 && count('SELECT COUNT(*) n FROM fcm_subscriptions WHERE user_id = ?', A) === 1);
    r = await req('DELETE', '/api/push/subscribe', { token: tD, json: { endpoint: 'x'.repeat(5000) } });
    ok('D9 oversized delete identifier → fixed 400', r.status === 400 && !r.text.includes('xxxx'));
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'http://127.0.0.1:9/legacy', 'k', 'a')").run(A);
    r = await req('DELETE', '/api/push/subscribe', { token: tD, json: { endpoint: 'http://127.0.0.1:9/legacy' } });
    ok('D10 legacy invalid row can still be deleted by its owner', r.status === 200 && count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = 'http://127.0.0.1:9/legacy'") === 0);
    const tL = mkSession(A);
    r = await req('POST', '/auth/logout', { token: tL, json: { pushEndpoint: 'y'.repeat(5000), fcmToken: { a: 1 } } });
    ok('D11 logout with junk identifiers still logs out (200, session gone)', r.status === 200 && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tL) === 0);
    db.prepare("INSERT INTO fcm_subscriptions (user_id, fcm_token) VALUES (?, 'legacy bad token!')").run(A);
    r = await req('DELETE', '/api/push/fcm-subscribe', { token: tD, json: { fcmToken: 'legacy bad token!' } });
    ok('D13 legacy invalid FCM token can still be deleted by its owner', r.status === 200 && count("SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = 'legacy bad token!'") === 0);
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'http://legacy.invalid/x', 'k', 'a')").run(A);
    db.prepare("INSERT INTO fcm_subscriptions (user_id, fcm_token) VALUES (?, 'legacy two!')").run(A);
    const tL2 = mkSession(A);
    await req('POST', '/auth/logout', { token: tL2, json: { pushEndpoint: 'http://legacy.invalid/x', fcmToken: 'legacy two!' } });
    ok('D14 logout removes this device\'s legacy (pre-validation) rows', count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = 'http://legacy.invalid/x'") === 0 && count("SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = 'legacy two!'") === 0);

    // ── F. Read-only push inventory (owner only, counts only) ────────────────
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (NULL, 'https://fcm.googleapis.com/fcm/send/ORPHANSECRET', 'k', 'a')").run();
    db.prepare("INSERT INTO fcm_subscriptions (user_id, fcm_token) VALUES (NULL, 'ORPHANTOKENSECRET:APA91bQQQQQQQQQQQQQQQQQQQQQQQQ')").run();
    const before = { w: count('SELECT COUNT(*) n FROM push_subscriptions'), f: count('SELECT COUNT(*) n FROM fcm_subscriptions') };
    const tOwner = mkSession(OWNER);
    r = await req('GET', '/api/health/push-inventory', { token: tOwner });
    ok('F1 owner gets ownerless counts', r.status === 200 && r.data?.ownerless?.push_subscriptions === 1 && r.data?.ownerless?.fcm_subscriptions === 1, r.text.slice(0, 200));
    ok('F2 inventory contains counts only (no endpoints or tokens)', !/ORPHAN|https?:\/\/|APA91b|SECRET/.test(r.text));
    ok('F3 inventory is read-only', count('SELECT COUNT(*) n FROM push_subscriptions') === before.w && count('SELECT COUNT(*) n FROM fcm_subscriptions') === before.f);
    const rT = await req('GET', '/api/health/push-inventory', { token: tD });
    const rAnon = await req('GET', '/api/health/push-inventory');
    ok('F4 inventory is owner-only (tester 403, anonymous 401)', rT.status === 403 && rAnon.status === 401);
    const sess = r.data?.sessions || {};
    const allTokens = db.prepare('SELECT token FROM sessions').all().map(x => x.token);
    ok('F5 inventory reports session housekeeping counts only (active / in grace / eligible / unparseable), never tokens',
      ['active', 'expiredWithinGrace', 'expiredEligible', 'unparseable'].every(k => Number.isInteger(sess[k])) && sess.active >= 1
      && 'lastHousekeeping' in r.data && !allTokens.some(t => r.text.includes(t)));
  } catch (err) {
    fail++; say('FAIL  harness error — ' + (err.stack || err.message));
  } finally {
    server.close();
  }

  // ── D12. send-time skip (fresh module instance with stubbed transports) ───
  try {
    const out = execFileSync(process.execPath, ['-e', `
      const Module = require('module'); const sent = []; const fcmSent = []; const logs = [];
      for (const m of ['log','info','warn','error']) console[m] = (...a) => logs.push(a.join(' '));
      const o = Module._load; Module._load = function (r) {
        if (r === 'web-push') return { setVapidDetails() {}, sendNotification: async (s) => { sent.push(s.endpoint); return {}; } };
        if (r === 'firebase-admin') { const a = { apps: [], initializeApp() { a.apps.push(1); }, credential: { cert: () => ({}) },
          messaging: () => ({ sendEachForMulticast: async (m) => { fcmSent.push(...m.tokens); return { successCount: m.tokens.length, responses: m.tokens.map(() => ({ success: true })) }; } }) }; return a; }
        return o.apply(this, arguments); };
      process.env.DB_PATH = ${JSON.stringify(TMP)}; process.env.VAPID_PUBLIC_KEY = 'x'; process.env.VAPID_PRIVATE_KEY = 'y'; process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
      const db = require(${JSON.stringify(path.join(BE, 'db'))});
      db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (${A}, 'https://10.0.0.9/ssrf', 'k', 'a')").run();
      db.prepare("INSERT INTO fcm_subscriptions (user_id, fcm_token) VALUES (${A}, 'bad token <x>')").run();
      require(${JSON.stringify(path.join(BE, 'services/pushService'))}).sendPush(${A}, { title: 't', body: 'b' }).then(() => {
        const left = db.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = 'https://10.0.0.9/ssrf'").get().n;
        const fcmLeft = db.prepare("SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = 'bad token <x>'").get().n;
        process.stdout.write(JSON.stringify({ sent, left, fcmSent, fcmLeft, logLeak: logs.some(l => l.includes('10.0.0.9') || l.includes('bad token')) }));
      });`], { encoding: 'utf8', cwd: BE, stdio: ['ignore', 'pipe', 'ignore'] });
    const res = JSON.parse(out.trim());
    ok('D12 send-time: invalid stored row skipped (no request), valid rows sent, nothing deleted',
      !res.sent.includes('https://10.0.0.9/ssrf') && res.sent.length >= 4 && res.left === 1, JSON.stringify({ n: res.sent.length, left: res.left }));
    ok('D15 send-time: invalid FCM token skipped, valid token sent, nothing deleted',
      !res.fcmSent.includes('bad token <x>') && res.fcmSent.length >= 1 && res.fcmLeft === 1, JSON.stringify({ n: res.fcmSent.length, left: res.fcmLeft }));
    ok('D16 send-time skip logs counts only (no endpoint or token)', res.logLeak === false);
  } catch (err) { fail++; say('FAIL  D12 harness — ' + err.message); }

  // ── E. contacts migration (separate processes, separate temp DBs) ─────────
  const boot = (dbPath) => {
    const out = execFileSync(process.execPath, ['-e', `
      const errs = []; console.error = (...a) => errs.push(a.join(' ')); console.log = () => {}; console.warn = (...a) => errs.push(a.join(' '));
      process.env.DB_PATH = ${JSON.stringify('__DB__')};
      const db = require(${JSON.stringify(path.join(BE, 'db'))});
      const cols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'contacts'").get().sql;
      const left = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('contacts_new','contacts_v3')").all().length;
      const rows = db.prepare('SELECT phone, name, user_id, company, contact_type, notes FROM contacts ORDER BY phone').all();
      process.stdout.write(JSON.stringify({ errs: errs.filter(e => /\\[DB\\].*(error|fail)/i.test(e)), cols, unique: /UNIQUE\\s*\\(\\s*user_id\\s*,\\s*phone\\s*\\)/i.test(sql), left, rows }));
    `.replace('__DB__', dbPath.replace(/\\/g, '\\\\'))], { encoding: 'utf8', cwd: BE, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  };
  const mkdb = (setupSql) => {
    const p = path.join(os.tmpdir(), `plumbline-migr-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
    if (setupSql) {
      execFileSync(process.execPath, ['-e', `
        const D = require(${JSON.stringify(path.join(BE, 'node_modules/better-sqlite3'))});
        const d = new D(${JSON.stringify(p)}); d.exec(${JSON.stringify(setupSql)}); d.close();`], { stdio: 'ignore' });
    }
    return p;
  };
  const cleanup = (p) => { for (const f of [p, `${p}-wal`, `${p}-shm`]) { try { fs.unlinkSync(f); } catch {} } };
  try {
    const p1 = mkdb(null);
    const f1 = boot(p1), f1b = boot(p1);
    ok('E1 brand-new DB initialises with no migration errors', f1.errs.length === 0, f1.errs.join(' | '));
    ok('E2 brand-new DB has the final contacts schema (id, user_id, UNIQUE(user_id, phone))', ['id', 'user_id', 'phone', 'company', 'contact_type'].every(c => f1.cols.includes(c)) && f1.unique && f1.left === 0);
    ok('E3 re-booting a fresh DB is a no-op', f1b.errs.length === 0 && JSON.stringify(f1b.cols) === JSON.stringify(f1.cols));
    cleanup(p1);

    const p2 = mkdb(`CREATE TABLE contacts (phone TEXT PRIMARY KEY, address TEXT, email TEXT, notes TEXT, preferred_contact_method TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, name TEXT);
      INSERT INTO contacts (phone, notes, name) VALUES ('+15550000001', 'gate code 12', 'Ann'), ('+15550000002', NULL, 'Bo');`);
    const f2 = boot(p2);
    ok('E4 legacy DB without user_id upgrades with all rows kept', f2.errs.length === 0 && f2.unique && f2.left === 0 && f2.rows.length === 2
      && f2.rows[0].notes === 'gate code 12' && f2.rows[0].name === 'Ann' && f2.rows.every(r => r.contact_type === 'Lead'), JSON.stringify(f2.errs));
    cleanup(p2);

    const p3 = mkdb(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, display_name TEXT, api_key TEXT, password_hash TEXT, is_owner INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO users (id, email, is_owner) VALUES (7, 'o@example.test', 0);
      CREATE TABLE contacts (phone TEXT PRIMARY KEY, address TEXT, email TEXT, notes TEXT, preferred_contact_method TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, name TEXT, user_id INTEGER, company TEXT, contact_type TEXT NOT NULL DEFAULT 'Lead');
      INSERT INTO contacts (phone, name, user_id, company, contact_type) VALUES ('+15550000003', 'Cy', 7, 'RCo', 'Supplier'), ('+15550000004', 'Di', 99, NULL, 'Lead');`);
    const f3 = boot(p3);
    const cy = f3.rows.find(r => r.phone === '+15550000003');
    ok('E5 legacy DB with user_id/company/contact_type upgrades without data loss (incl. orphan owner)',
      f3.errs.length === 0 && f3.unique && f3.left === 0 && f3.rows.length === 2 && cy?.user_id === 7 && cy?.company === 'RCo' && cy?.contact_type === 'Supplier'
      && f3.rows.some(r => r.phone === '+15550000004' && r.user_id === 99), JSON.stringify(f3.errs));
    cleanup(p3);

    const p4 = mkdb(null);
    boot(p4);
    execFileSync(process.execPath, ['-e', `
      const D = require(${JSON.stringify(path.join(BE, 'node_modules/better-sqlite3'))});
      const d = new D(${JSON.stringify(p4)});
      d.prepare("INSERT INTO users (id, email, is_owner) VALUES (5, 'own@example.test', 1)").run();
      d.prepare("INSERT INTO contacts (user_id, phone, name, notes, company, contact_type) VALUES (5, '+15550000005', 'Ed', 'n', 'ECo', 'Customer')").run();
      d.close();`], { stdio: 'ignore' });
    const before = boot(p4).rows, after = boot(p4);
    ok('E6 already-migrated DB is left untouched across boots', after.errs.length === 0 && JSON.stringify(after.rows) === JSON.stringify(before) && after.rows[0]?.company === 'ECo');
    cleanup(p4);

    // Intermediate (phone TEXT NOT NULL) schema with an orphan owner and company data.
    const p5 = mkdb(`CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, phone TEXT NOT NULL, name TEXT, address TEXT, email TEXT, notes TEXT,
        preferred_contact_method TEXT, formatted_address TEXT, address_line_1 TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT, lat REAL, lng REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, company TEXT, contact_type TEXT NOT NULL DEFAULT 'Lead', UNIQUE(user_id, phone));
      INSERT INTO contacts (id, user_id, phone, name, company, contact_type) VALUES (41, 77, '+15550000041', 'Fay', 'FCo', 'Vendor');`);
    const f5 = boot(p5);
    const fay = f5.rows.find(r => r.phone === '+15550000041');
    ok('E7 phone-NOT-NULL intermediate schema upgrades atomically, keeping company/contact_type and orphan owner',
      f5.errs.length === 0 && f5.left === 0 && fay?.company === 'FCo' && fay?.contact_type === 'Vendor' && fay?.user_id === 77, JSON.stringify(f5.errs));
    cleanup(p5);

    // A half-built contacts_new left by an earlier failed run must not block recovery.
    const p6 = mkdb(`CREATE TABLE contacts (phone TEXT PRIMARY KEY, address TEXT, email TEXT, notes TEXT, preferred_contact_method TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, name TEXT);
      INSERT INTO contacts (phone, name) VALUES ('+15550000061', 'Gil');
      CREATE TABLE contacts_new (id INTEGER PRIMARY KEY);`);
    const f6 = boot(p6);
    ok('E8 leftover contacts_new from a failed run is cleared and the migration completes', f6.errs.length === 0 && f6.left === 0 && f6.rows.length === 1 && f6.rows[0].name === 'Gil', JSON.stringify(f6.errs));
    cleanup(p6);

    // Owner + legacy contacts without user_id: the first boot stamps contacts to the owner.
    const p7 = mkdb(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, display_name TEXT, api_key TEXT, password_hash TEXT, is_owner INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO users (id, email, is_owner) VALUES (3, 'owner3@example.test', 1);
      CREATE TABLE contacts (phone TEXT PRIMARY KEY, address TEXT, email TEXT, notes TEXT, preferred_contact_method TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, name TEXT);
      INSERT INTO contacts (phone, name) VALUES ('+15550000071', 'Hal');`);
    const f7 = boot(p7);
    ok('E9 owner stamping runs after the contacts upgrade on the first boot', f7.errs.length === 0 && f7.rows[0]?.user_id === 3, JSON.stringify(f7.errs));
    cleanup(p7);
  } catch (err) { fail++; say('FAIL  E harness — ' + err.message); }

  say(`\n${pass} passed, ${fail} failed`);
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
}

run();
