'use strict';
/**
 * DEF-9 security tests (RELEASE_READINESS_TEST_REPORT.md): auth hardening.
 *
 *   A. Gmail OAuth state: random, single-use, 10-minute, bound to the
 *      initiating account AND browser; rejects missing / malformed / unknown /
 *      expired / reused / wrong-browser / account-mismatched / suspended-
 *      initiator callbacks; never logs codes, tokens, state or nonce.
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
const google = { instances: 0, getTokenCalls: 0, revoked: [], nextScope: null, emailFor: {} };
const FULL_SCOPE = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email';
class FakeOAuth2 {
  constructor() { google.instances++; this.creds = null; }
  generateAuthUrl(o) { return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(o.state)}&scope=x`; }
  async getToken(code) {
    google.getTokenCalls++;
    if (code === 'boom') throw Object.assign(new Error('token endpoint failed for code=boom SECRET-boom'), { code: 'invalid_grant' });
    return { tokens: { access_token: `AT-${code}`, refresh_token: `RT-${code}`, expiry_date: Date.now() + 3600e3, scope: google.nextScope ?? FULL_SCOPE } };
  }
  setCredentials(t) { this.creds = t; }
  async revokeToken(t) { google.revoked.push(t); }
}
let whisperCalls = 0;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
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
  const errCode = (r) => new URL(r.headers.get('location') || 'https://x/').searchParams.get('gmail_error');
  const startFlow = async (token) => {
    const r = await req('GET', '/auth/google', { cookies: { plumbline_session: token } });
    const loc = r.headers.get('location') || '';
    const state = new URL(loc).searchParams.get('state');
    return { r, state, nonce: cookieVal(r.setCookies, 'plumbline_goauth'), cookie: r.setCookies.find(s => s.startsWith('plumbline_goauth=')) || '' };
  };
  const callback = (q, cookies) => req('GET', `/auth/google/callback?${new URLSearchParams(q)}`, { cookies });
  const gmailRow = (uid) => db.prepare('SELECT * FROM gmail_tokens WHERE user_id = ?').get(uid);

  try {
    // ── A. Gmail OAuth state ────────────────────────────────────────────────
    const tA = mkSession(A), tB = mkSession(B), tC = mkSession(C);
    let r = await req('GET', '/auth/google');
    ok('A1 /auth/google without a session cookie → session_required, no flow created', errCode(r) === 'session_required' && count('SELECT COUNT(*) n FROM gmail_oauth_states') === 0);
    // Attack: a link carrying the ATTACKER's session token must not start a flow.
    r = await req('GET', `/auth/google?token=${tA}`);
    const r2a = await req('GET', '/auth/google', { token: tA });
    ok('A1b start link with ?token= or Bearer (no cookie) is refused — no flow bound to that account', errCode(r) === 'session_required' && errCode(r2a) === 'session_required' && count('SELECT COUNT(*) n FROM gmail_oauth_states') === 0);

    const fa = await startFlow(tA);
    const row = fa.state ? db.prepare('SELECT * FROM gmail_oauth_states WHERE state_hash = ?').get(sha(fa.state)) : null;
    ok('A2 start → redirect to Google with 256-bit state + browser nonce cookie',
      fa.r.status === 302 && /^[A-Za-z0-9_-]{43}$/.test(fa.state || '') && /^[A-Za-z0-9_-]{43}$/.test(fa.nonce || ''), `status=${fa.r.status}`);
    ok('A3 nonce cookie is HttpOnly, SameSite=Lax, scoped to /auth/google',
      /HttpOnly/i.test(fa.cookie) && /SameSite=Lax/i.test(fa.cookie) && /Path=\/auth\/google/i.test(fa.cookie));
    ok('A4 only hashes stored; bound to initiator; ~10 min expiry',
      row && row.user_id === A && row.nonce_hash === sha(fa.nonce) && !JSON.stringify(row).includes(fa.state)
      && Math.abs(Date.parse(row.expires_at) - Date.now() - 600e3) < 15e3);

    const fb = await startFlow(tB);
    ok('A5 concurrent flows get distinct state (no shared slot)', fb.state && fb.state !== fa.state);

    // Account-linking attack: A's consent link completed in a different browser
    // (no nonce cookie, victim signed in as B) must not attach anything.
    const gtBefore = google.getTokenCalls;
    r = await callback({ state: fa.state, code: 'victimcode' }, { plumbline_session: tB });
    ok('A6 attack: callback without the initiating browser nonce → rejected', errCode(r) === 'state_invalid' && !gmailRow(A) && !gmailRow(B) && google.getTokenCalls === gtBefore);
    r = await callback({ state: fa.state, code: 'codeA' }, { plumbline_goauth: fa.nonce });
    ok('A7 state is single-use even after a rejected attempt (consumed)', errCode(r) === 'state_invalid' && !gmailRow(A));

    // Happy paths for B (in-flight) and a fresh A flow — both succeed.
    google.emailFor['AT-codeB'] = 'b-mailbox@example.test';
    r = await callback({ state: fb.state, code: 'codeB' }, { plumbline_goauth: fb.nonce, plumbline_session: tB });
    ok('A8 valid callback stores tokens for the initiator only', r.status === 303 && /gmail_connected=1/.test(r.headers.get('location')) && gmailRow(B)?.email === 'b-mailbox@example.test' && !gmailRow(A));
    ok('A9 redirect goes to the first FRONTEND_URL entry', (r.headers.get('location') || '').startsWith('https://app.example.test/?'));
    r = await callback({ state: fb.state, code: 'codeB2' }, { plumbline_goauth: fb.nonce, plumbline_session: tB });
    ok('A10 replay of a used state → rejected, tokens unchanged', errCode(r) === 'state_invalid' && gmailRow(B)?.access_token === 'AT-codeB');

    const fa2 = await startFlow(tA);
    r = await callback({ state: fa2.state, code: 'codeX' }, { plumbline_goauth: fa2.nonce, plumbline_session: tC });
    ok('A11 account mismatch (signed in as another user) → rejected', errCode(r) === 'state_invalid' && !gmailRow(A) && !gmailRow(C));

    r = await callback({ code: 'c' }, {});
    ok('A12 missing state → rejected', errCode(r) === 'state_invalid');
    r = await callback({ state: 'not-a-valid-state!', code: 'c' }, {});
    ok('A13 malformed state → rejected', errCode(r) === 'state_invalid');
    r = await callback({ state: crypto.randomBytes(32).toString('base64url'), code: 'c' }, {});
    ok('A14 unknown state → rejected', errCode(r) === 'state_invalid');

    const fa3 = await startFlow(tA);
    db.prepare('UPDATE gmail_oauth_states SET expires_at = ? WHERE state_hash = ?').run(new Date(Date.now() - 1000).toISOString(), sha(fa3.state));
    r = await callback({ state: fa3.state, code: 'codeExp' }, { plumbline_goauth: fa3.nonce, plumbline_session: tA });
    ok('A15 expired state (1 s past) → rejected', errCode(r) === 'state_invalid' && !gmailRow(A));

    const fa4 = await startFlow(tA);
    r = await callback({ state: fa4.state, code: 'codeWrongNonce' }, { plumbline_goauth: fa.nonce, plumbline_session: tA });
    ok('A16 wrong browser nonce → rejected', errCode(r) === 'state_invalid' && !gmailRow(A));

    const fa5 = await startFlow(tA);
    google.nextScope = 'https://www.googleapis.com/auth/userinfo.email';
    const revBefore = google.revoked.length;
    r = await callback({ state: fa5.state, code: 'codeNoScope' }, { plumbline_goauth: fa5.nonce });
    google.nextScope = null;
    ok('A17 required Gmail scopes missing → rejected and grant revoked', errCode(r) === 'missing_scopes' && !gmailRow(A) && google.revoked.length === revBefore + 1);

    const fa6 = await startFlow(tA);
    r = await callback({ state: fa6.state, error: 'access_denied' }, { plumbline_goauth: fa6.nonce });
    ok('A18 Google access_denied → generic code, state consumed', errCode(r) === 'access_restricted'
      && db.prepare('SELECT used_at FROM gmail_oauth_states WHERE state_hash = ?').get(sha(fa6.state))?.used_at);

    const tSuspLater = mkUser('later-suspended@example.test');
    const tsl = mkSession(tSuspLater);
    const fs1 = await startFlow(tsl);
    db.prepare('UPDATE users SET is_suspended = 1 WHERE id = ?').run(tSuspLater);
    r = await callback({ state: fs1.state, code: 'codeSusp' }, { plumbline_goauth: fs1.nonce });
    ok('A19 initiator suspended before callback → rejected', errCode(r) === 'state_invalid' && !gmailRow(tSuspLater));

    google.emailFor['AT-codeA'] = 'a-mailbox@example.test';
    const fa7 = await startFlow(tA);
    r = await callback({ state: fa7.state, code: 'codeA' }, { plumbline_goauth: fa7.nonce });
    ok('A20 valid flow without a session cookie (Safari/Capacitor browser) succeeds for initiator', gmailRow(A)?.email === 'a-mailbox@example.test' && gmailRow(B)?.email === 'b-mailbox@example.test');

    process.env.GMAIL_OAUTH_ENABLED = 'false';
    r = await callback({ state: crypto.randomBytes(32).toString('base64url'), code: 'c' }, {});
    ok('A21 callback refused while Gmail OAuth is disabled', errCode(r) === 'oauth_disabled');
    process.env.GMAIL_OAUTH_ENABLED = 'true';

    const revB4 = google.revoked.length;
    r = await req('DELETE', '/auth/gmail-disconnect', { token: tA });
    await new Promise(res => setTimeout(res, 30));
    ok('A22 disconnect deletes only own tokens and revokes at Google', r.status === 200 && !gmailRow(A) && !!gmailRow(B) && google.revoked[revB4] === 'RT-codeA');
    ok('A23 a fresh OAuth client per request (no shared client)', google.instances >= 10, `instances=${google.instances}`);
    const secrets = ['victimcode', 'codeA', 'codeB', 'AT-codeA', 'RT-codeA', 'AT-codeB', 'RT-codeB', fa.state, fa.nonce, fb.state, fb.nonce, 'fake-client-secret'];
    ok('A24 no OAuth code, token, state, nonce or secret appears in logs', !logged.some(l => secrets.some(s => s && l.includes(s))));

    const fe = await startFlow(tA);
    ok('A25 start sets Referrer-Policy: no-referrer and no-store', fe.r.headers.get('referrer-policy') === 'no-referrer' && /no-store/.test(fe.r.headers.get('cache-control') || ''));
    ok('A26 a new start replaces the user\'s earlier unused attempts', count('SELECT COUNT(*) n FROM gmail_oauth_states WHERE user_id = ? AND used_at IS NULL', A) === 1);
    r = await callback({ state: fe.state, error: 'server_error<ECHO-PROBE>' }, { plumbline_goauth: fe.nonce });
    ok('A27 other Google errors map to a generic code; the raw value is not logged or echoed', errCode(r) === 'oauth_error'
      && !logged.some(l => l.includes('ECHO-PROBE')) && !String(r.headers.get('location')).includes('ECHO-PROBE'));
    ok('A28 callback clears the browser nonce cookie', r.setCookies.some(c => /^plumbline_goauth=;/.test(c) && /Expires=Thu, 01 Jan 1970/i.test(c)));
    const fbm = await startFlow(tA);
    r = await callback({ state: fbm.state, code: 'boom' }, { plumbline_goauth: fbm.nonce });
    ok('A29 token-exchange failure → callback_failed, error text never logged', errCode(r) === 'callback_failed' && !logged.some(l => l.includes('SECRET-boom') || l.includes('code=boom')));
    const gone = mkUser('deleted-initiator@example.test');
    const fd = await startFlow(mkSession(gone));
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(gone);
    let delErr = null;
    try { db.prepare('DELETE FROM users WHERE id = ?').run(gone); } catch (e) { delErr = e.message; }
    ok('A30 deleting a user with an open OAuth attempt works (ON DELETE CASCADE)', delErr === null && count('SELECT COUNT(*) n FROM gmail_oauth_states WHERE user_id = ?', gone) === 0, delErr || '');
    r = await callback({ state: fd.state, code: 'codeGone' }, { plumbline_goauth: fd.nonce });
    ok('A31 deleted initiator → rejected', errCode(r) === 'state_invalid' && !gmailRow(gone));
    authRouter.gmailStartLimit.clear();
    const tLim = mkSession(B);
    let lastLim = null;
    for (let i = 0; i < 11; i++) lastLim = await req('GET', '/auth/google', { cookies: { plumbline_session: tLim } });
    ok('A32 Gmail connect starts are rate-limited per user', errCode(lastLim) === 'too_many_attempts');
    authRouter.gmailStartLimit.clear();
    // Shared Google address: disconnecting one account must not revoke the other's grant.
    db.prepare("INSERT INTO gmail_tokens (email, access_token, refresh_token, user_id) VALUES ('shared@example.test', 'AT-s1', 'RT-s1', ?)").run(A);
    db.prepare("UPDATE gmail_tokens SET email = 'shared@example.test' WHERE user_id = ?").run(B);
    const revS = google.revoked.length;
    await req('DELETE', '/auth/gmail-disconnect', { token: tA });
    await new Promise(res => setTimeout(res, 30));
    ok('A33 disconnect skips the Google revoke when another account uses the same Gmail', !gmailRow(A) && !!gmailRow(B) && google.revoked.length === revS);

    // ── B. Suspension and session expiry ────────────────────────────────────
    r = await req('POST', '/auth/login', { json: { email: 'suspended@example.test', password: PW }, ip: '198.51.100.1' });
    ok('B1 suspended user with correct password → 403 ACCOUNT_SUSPENDED, no session', r.status === 403 && r.data?.code === 'ACCOUNT_SUSPENDED' && count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', SUSP) === 0);
    r = await req('POST', '/auth/login', { json: { email: 'suspended@example.test', password: 'wrong' }, ip: '198.51.100.1' });
    ok('B2 suspended user with wrong password → generic 401 (status not revealed)', r.status === 401 && r.data?.error === 'Invalid email or password');
    r = await req('POST', '/auth/login', { json: { email: 'c@example.test', password: PW }, ip: '198.51.100.2' });
    const cTok = r.data?.token;
    ok('B3 active user login still works', r.status === 200 && !!cTok && (await req('GET', '/api/whoami', { token: cTok })).data?.userId === C);
    db.prepare('UPDATE users SET is_suspended = 1 WHERE id = ?').run(C);
    r = await req('GET', '/api/whoami', { token: cTok });
    ok('B4 open session stops working after suspension (401 ACCOUNT_SUSPENDED)', r.status === 401 && r.data?.code === 'ACCOUNT_SUSPENDED');
    ok('B5 all of the suspended user\'s sessions are removed', count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', C) === 0);
    const cTok2 = mkSession(C);
    r = await req('GET', '/auth/me', { token: cTok2 });
    ok('B6 /auth/me rejects a suspended account and removes its sessions', r.status === 401 && r.data?.code === 'ACCOUNT_SUSPENDED' && count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', C) === 0);
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
