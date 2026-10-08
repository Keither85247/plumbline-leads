'use strict';
/**
 * Account-lifecycle security tests (RELEASE_READINESS_TEST_REPORT.md DEF-11).
 *
 *   S. Account status rules: suspended and blocked are disabled; paywall
 *      states ('unknown', 'trial') and owners are not.
 *   L. Sign-in and sessions for disabled accounts; stale-cookie / conflicting
 *      credentials; logout device cleanup after sessions are purged.
 *   T. Twilio inbound/outbound for disabled accounts: acknowledged, nothing
 *      created / altered / notified / sent to AI, never re-routed.
 *   P. Push delivery skips disabled accounts.
 *   G. Gmail sync pauses for disabled accounts and backfills on reinstatement.
 *   O. Outbound and paid-AI routes refuse disabled sessions.
 *   R. Translation limits (per account, shared all-AI global ceiling).
 *   H. Expired-session housekeeping: boundaries, formats, batching, index use,
 *      concurrency (in-process and cross-process), time zones.
 *
 * Hermetic: temp SQLite DBs, synthetic accounts, fake Twilio media / OpenAI /
 * web-push / Firebase / Google, no network, no production data.
 *
 * Run:  node backend/scripts/test-lifecycle.js
 * Exit: 0 = all pass, 1 = any failure.
 */
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');
const Module = require('module');
const { execFileSync, spawn } = require('child_process');

const BE  = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `plumbline-lifecycle-test-${process.pid}.db`);
const cleanupDb = (p) => { for (const f of [p, `${p}-wal`, `${p}-shm`]) { try { fs.unlinkSync(f); } catch {} } };
cleanupDb(TMP);
process.env.DB_PATH  = TMP;
process.env.DATA_DIR = path.join(os.tmpdir(), `plumbline-lifecycle-data-${process.pid}`);

const AUTH_TOKEN = 'test_auth_token_' + crypto.randomBytes(8).toString('hex');
const BASE_URL   = 'https://backend.example.onrender.com';
Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_BASE_URL: BASE_URL,
  TWILIO_PHONE_NUMBER: '+15550000000', TWILIO_TWIML_APP_SID: 'AP' + '0'.repeat(32),
  TWILIO_API_KEY_SID: 'SK' + '0'.repeat(32), TWILIO_API_KEY_SECRET: 'fake-secret',
  OPENAI_API_KEY: 'sk-test-not-used',
  VAPID_PUBLIC_KEY: 'fake-vapid-public', VAPID_PRIVATE_KEY: 'fake-vapid-private',
  FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
  FRONTEND_URL: 'https://app.example.test',
  TRUST_CF_CONNECTING_IP: 'true',
  ENABLE_TESTER_BYPASS: 'true',
});
delete process.env.NODE_ENV;
delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;

// ── Capture console output (to prove submitted content / tokens are never logged)
const logged = [];
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (process.env.VERBOSE) orig(...a); };
}
const origStdout = process.stdout.write.bind(process.stdout);
const say = (s) => origStdout(s + '\n');

// ── Stubs: record everything that would leave the server ─────────────────────
const sent = { web: [], fcm: [], downloads: 0, whisper: 0, chat: 0, chatInputs: [] };
const { PassThrough, EventEmitter } = { PassThrough: require('stream').PassThrough, EventEmitter: require('events') };
const fakeHttps = {
  get(url, opts, cb) {
    sent.downloads++;
    const r = new EventEmitter();
    setImmediate(() => { const res = new PassThrough(); res.statusCode = 200; cb(res); res.end(Buffer.from('fake-mp3')); });
    return r;
  },
};
const gmailApi = { listCalls: [] };
const aiFail = { next: null };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'https' && parent && /routes[\\/]twilio\.js$/.test(parent.filename)) return fakeHttps;
  if (request === 'openai') {
    return class OpenAI { constructor() {
      this.audio = { transcriptions: { create: async ({ file } = {}) => { sent.whisper++; if (file?.[Symbol.asyncIterator]) { for await (const _ of file) {} } return { text: 'Need a quote for a leaking pipe.' }; } } };
      this.chat = { completions: { create: async (req) => {
        if (aiFail.next) throw Object.assign(new Error(aiFail.next), { status: 429 });
        sent.chat++; sent.chatInputs.push(req);
        const sys = req.messages?.[0]?.content || '';
        if (/translator/.test(sys)) return { choices: [{ message: { content: 'Hola' } }] };
        return { choices: [{ message: { content: JSON.stringify({ contactName: 'Pat', category: 'Lead', summary: 'Pat – quote', keyPoints: [], followUpText: 'Hi' }) } }] };
      } } };
    } };
  }
  if (request === 'web-push') return { setVapidDetails() {}, sendNotification: async (s) => { sent.web.push(s.endpoint); return {}; } };
  if (request === 'firebase-admin') {
    const a = { apps: [], initializeApp() { a.apps.push(1); }, credential: { cert: () => ({}) },
      messaging: () => ({ sendEachForMulticast: async (m) => { sent.fcm.push(...m.tokens); return { successCount: m.tokens.length, responses: m.tokens.map(() => ({ success: true })) }; } }) };
    return a;
  }
  if (request === 'googleapis') {
    class OAuth2 { setCredentials() {} on(ev, fn) { (this.handlers ||= {})[ev] = fn; } generateAuthUrl() { return 'https://accounts.google.com/x'; } }
    return { google: {
      auth: { OAuth2 },
      oauth2: () => ({ userinfo: { get: async () => ({ data: { email: 'x@example.test' } }) } }),
      gmail: () => ({ users: { messages: { list: async () => ({ data: { messages: [] } }), get: async () => ({ data: {} }) } } }),
    } };
  }
  return origLoad.apply(this, arguments);
};

const express      = require(path.join(BE, 'node_modules/express'));
const cookieParser = require(path.join(BE, 'node_modules/cookie-parser'));
const twilio       = require(path.join(BE, 'node_modules/twilio'));
const bcrypt       = require(path.join(BE, 'node_modules/bcrypt'));
const db           = require(path.join(BE, 'db'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); say(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const count = (sql, ...p) => db.prepare(sql).get(...p).n;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Accounts & numbers ───────────────────────────────────────────────────────
const PW = 'correct-horse-battery';
const HASH = bcrypt.hashSync(PW, 4);
function mkUser(email, { owner = false, suspended = false, status = 'tester' } = {}) {
  return Number(db.prepare('INSERT INTO users (email, display_name, password_hash, is_owner, is_suspended, access_status) VALUES (?,?,?,?,?,?)')
    .run(email, email, HASH, owner ? 1 : 0, suspended ? 1 : 0, status).lastInsertRowid);
}
function mkSession(userId, msFromNow = 3600e3) {
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(t, userId, new Date(Date.now() + msFromNow).toISOString());
  return t;
}
const OWNER = mkUser('owner@example.test', { owner: true, status: 'unknown' });
const ACT   = mkUser('active@example.test');
const SUS   = mkUser('suspended@example.test', { suspended: true });
const BLK   = mkUser('blocked@example.test', { status: 'blocked' });
const UNK   = mkUser('unknown@example.test', { status: 'unknown' });
const TRI   = mkUser('trial@example.test', { status: 'trial' });
const NUM = { ACT: '+15551110001', SUS: '+15551110002', BLK: '+15551110003', FREE: '+15551110009' };
const insNum = db.prepare('INSERT INTO phone_numbers (phone_number, twilio_sid, assigned_user_id) VALUES (?,?,?)');
insNum.run(NUM.ACT, 'PN' + '1'.repeat(32), ACT);
insNum.run(NUM.SUS, 'PN' + '2'.repeat(32), SUS);
insNum.run(NUM.BLK, 'PN' + '3'.repeat(32), BLK);
insNum.run(NUM.FREE, 'PN' + '9'.repeat(32), null);

function pushKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  return { p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}
function addDevice(userId, tag) {
  const k = pushKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${tag}-${crypto.randomBytes(8).toString('hex')}`;
  const fcm = `${tag}-fcm:APA91b${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)').run(userId, endpoint, k.p256dh, k.auth);
  db.prepare('INSERT INTO fcm_subscriptions (user_id, fcm_token) VALUES (?,?)').run(userId, fcm);
  return { endpoint, fcm };
}
const DEV = { ACT: addDevice(ACT, 'act'), SUS: addDevice(SUS, 'sus'), BLK: addDevice(BLK, 'blk'), OWNER: addDevice(OWNER, 'own') };
const setStatus = (uid, { suspended, status }) => {
  if (suspended !== undefined) db.prepare('UPDATE users SET is_suspended = ? WHERE id = ?').run(suspended ? 1 : 0, uid);
  if (status !== undefined) db.prepare('UPDATE users SET access_status = ? WHERE id = ?').run(status, uid);
};

async function run() {
  const acct         = require(path.join(BE, 'utils/accountStatus'));
  const authRouter   = require(path.join(BE, 'routes/auth'));
  const requireAuth  = require(path.join(BE, 'middleware/requireAuth'));
  const twilioRouter = require(path.join(BE, 'routes/twilio'));
  const tokenRouter  = require(path.join(BE, 'routes/token'));
  const transcribe   = require(path.join(BE, 'routes/transcribe'));
  const leadsRouter  = require(path.join(BE, 'routes/leads'));
  const translate    = require(path.join(BE, 'routes/translate'));
  const messages     = require(path.join(BE, 'routes/messages'));
  const numbers      = require(path.join(BE, 'routes/numbers'));
  const pushService  = require(path.join(BE, 'services/pushService'));
  const gmailSvc     = require(path.join(BE, 'services/gmailService'));
  const poller       = require(path.join(BE, 'jobs/gmailPoller'));
  const hk           = require(path.join(BE, 'jobs/housekeeping'));
  const session      = require(path.join(BE, 'utils/session'));
  const aiBudget     = require(path.join(BE, 'utils/aiBudget'));

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use('/auth', authRouter);
  app.use('/api/twilio', twilioRouter);
  app.use('/api/twilio/token', tokenRouter);
  app.use(requireAuth);
  app.get('/api/whoami', (req, res) => res.json({ userId: req.userId }));
  app.use('/api/leads', leadsRouter);
  app.use('/api/translate', translate);
  app.use('/api/messages', messages);
  app.use('/api/numbers', numbers);
  app.use('/api/transcribe', transcribe);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, p, { token, cookies = {}, json, form, headers = {}, ip = '198.51.100.7' } = {}) {
    const h = { ...headers, 'CF-Connecting-IP': ip };
    if (token) h.Authorization = `Bearer ${token}`;
    const ck = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) h.Cookie = ck;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, text, data, headers: r.headers, setCookies: r.headers.getSetCookie?.() || [] };
  }
  const twilioPost = (p, params) => req('POST', p, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, BASE_URL + p, params) },
    form: new URLSearchParams(params).toString(),
  });
  const snapshot = () => ({
    calls: count('SELECT COUNT(*) n FROM calls'), messages: count('SELECT COUNT(*) n FROM messages'),
    leads: count('SELECT COUNT(*) n FROM leads'), web: sent.web.length, fcm: sent.fcm.length,
    dl: sent.downloads, whisper: sent.whisper, chat: sent.chat,
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const login = (email, password = PW, ip) => req('POST', '/auth/login', { json: { email, password }, ip: ip || `203.0.113.${Math.floor(Math.random() * 200) + 1}` });

  try {
    // ── S. Status rules ───────────────────────────────────────────────────────
    const d = acct.isDisabledRow;
    ok('S1 suspended and blocked are disabled (incl. case/space variants); paywall states and owners are not',
      d({ is_suspended: 1 }) && d({ access_status: 'blocked' }) && d({ access_status: ' Blocked ' }) && d(null)
      && !d({ is_owner: 1, access_status: 'blocked' }) && ['unknown', 'tester', 'trial', 'active', '', null].every(s => !d({ access_status: s })));
    ok('S2 isAccountActive: active true; suspended/blocked/missing/invalid ids false',
      acct.isAccountActive(ACT) && acct.isAccountActive(OWNER) && acct.isAccountActive(UNK) && acct.isAccountActive(TRI)
      && !acct.isAccountActive(SUS) && !acct.isAccountActive(BLK) && !acct.isAccountActive(99999)
      && !acct.isAccountActive(0) && !acct.isAccountActive(-1) && !acct.isAccountActive(String(ACT)) && !acct.isAccountActive(null));
    const sqlDisabled = db.prepare(`SELECT id, ${acct.disabledSql('u')} AS dis, is_owner, is_suspended, access_status FROM users u`).all();
    ok('S3 the SQL predicate agrees with the JS rule for every account', sqlDisabled.every(r => !!r.dis === d(r)));

    // ── L. Sign-in and sessions ───────────────────────────────────────────────
    const sessionsBefore = count('SELECT COUNT(*) n FROM sessions');
    let r = await login('suspended@example.test');
    const r2 = await login('blocked@example.test');
    ok('L1 suspended and blocked accounts are refused at sign-in with one generic code; no session created',
      r.status === 403 && r.data?.code === 'ACCOUNT_DISABLED' && r2.status === 403 && r2.data?.code === 'ACCOUNT_DISABLED'
      && !r.data?.token && !r2.data?.token && count('SELECT COUNT(*) n FROM sessions') === sessionsBefore);
    r = await login('blocked@example.test', 'wrong-password');
    ok('L2 wrong password on a blocked account gets the normal generic 401 (status not revealed)', r.status === 401 && r.data?.error === 'Invalid email or password');
    const rU = await login('unknown@example.test'), rT = await login('trial@example.test');
    ok('L3 paywall states (unknown, trial) still sign in — they are not disabled', rU.status === 200 && rT.status === 200);

    const tB = mkSession(ACT);
    ok('L4 control: an active session works', (await req('GET', '/api/whoami', { token: tB })).status === 200);
    setStatus(ACT, { status: 'blocked' });
    r = await req('GET', '/api/whoami', { token: tB });
    ok('L5 blocking an account ends its existing sessions on the next request (expired, kept for logout cleanup)', r.status === 401 && r.data?.code === 'ACCOUNT_DISABLED'
      && count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND julianday(expires_at) > julianday('now')", ACT) === 0
      && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tB) === 1 && r.setCookies.some(c => c.startsWith('plumbline_session=;')));
    setStatus(ACT, { status: 'tester' });
    const tS = mkSession(ACT);
    setStatus(ACT, { suspended: true });
    r = await req('GET', '/auth/me', { token: tS });
    ok('L6 /auth/me ends a suspended account\'s sessions', r.status === 401 && r.data?.code === 'ACCOUNT_DISABLED' && count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND julianday(expires_at) > julianday('now')", ACT) === 0);
    // The suspended device's own logout (forced sign-out) still removes its push rows.
    const devS = addDevice(ACT, 'forced');
    r = await req('POST', '/auth/logout', { token: tS, json: { pushEndpoint: devS.endpoint, fcmToken: devS.fcm } });
    ok('L6b after a disabled account is signed out, the device\'s logout still removes its own push registration',
      r.status === 200 && count('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', devS.endpoint) === 0
      && count('SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = ?', devS.fcm) === 0);
    setStatus(ACT, { suspended: false });
    const tReinstated = tS;
    r = await req('GET', '/api/whoami', { token: tReinstated });
    ok('L6c reinstating an account does not revive its old sessions', r.status === 401);

    const good = mkSession(ACT), stale = crypto.randomBytes(16).toString('hex');
    r = await req('GET', '/api/whoami', { token: good, cookies: { plumbline_session: stale } });
    ok('L7 a stale cookie no longer hides a valid Bearer session; the stale cookie is cleared', r.status === 200 && r.data?.userId === ACT && r.setCookies.some(c => c.startsWith('plumbline_session=;')));
    const other = mkSession(UNK);
    r = await req('GET', '/api/whoami', { token: good, cookies: { plumbline_session: other } });
    const rMe = await req('GET', '/auth/me', { token: good, cookies: { plumbline_session: other } });
    ok('L8 valid credentials for two different accounts are rejected as ambiguous', r.status === 401 && rMe.status === 401);

    // Logout with an expired (not yet purged — 7-day grace) session still removes THIS device only.
    const devX = addDevice(ACT, 'logout'), devKeep = addDevice(ACT, 'keep');
    const gone = mkSession(ACT, -2 * 864e5);
    await hk.purgeExpiredSessions();
    r = await req('POST', '/auth/logout', { token: gone, json: { pushEndpoint: devX.endpoint, fcmToken: devX.fcm, } });
    const tOther = mkSession(UNK);
    const rSteal = await req('POST', '/auth/logout', { token: tOther, json: { pushEndpoint: devKeep.endpoint, fcmToken: devKeep.fcm } });
    ok('L9 logout with a session expired 2 days ago (kept by the grace) still removes this device\'s push rows; another account cannot remove them', r.status === 200 && rSteal.status === 200
      && count('SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = ?', devKeep.fcm) === 1
      && count('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', devX.endpoint) === 0
      && count('SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = ?', devX.fcm) === 0
      && count('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', devKeep.endpoint) === 1);
    const lo1 = mkSession(ACT), lo2 = mkSession(ACT);
    await req('POST', '/auth/logout', { token: lo1, cookies: { plumbline_session: lo2 } });
    ok('L10 logout ends both the cookie and the Bearer session it presents', count('SELECT COUNT(*) n FROM sessions WHERE token IN (?,?)', lo1, lo2) === 0);
    const tBlk = mkSession(BLK);
    r = await req('POST', '/auth/tester-bypass', { token: tBlk });
    ok('L11 a blocked account cannot use tester-bypass to unblock itself', r.status === 401
      && db.prepare('SELECT access_status s FROM users WHERE id = ?').get(BLK).s === 'blocked');

    // ── T. Twilio for disabled receiving accounts ─────────────────────────────
    const callSid = (n) => 'CA' + String(n).padStart(32, '0');
    for (const [label, num, uid] of [['suspended', NUM.SUS, SUS], ['blocked', NUM.BLK, BLK]]) {
      const before = snapshot();
      const ownerMsgs = count('SELECT COUNT(*) n FROM messages WHERE user_id = ?', OWNER);
      r = await twilioPost('/api/twilio/voice', { From: '+15557770001', To: num, CallSid: callSid(uid + 100), Direction: 'inbound' });
      const vXml = r.text;
      const rMiss = await twilioPost('/api/twilio/missed-call', { From: '+15557770001', To: num, DialCallStatus: 'no-answer', CallSid: callSid(uid + 100) });
      const rSms = await twilioPost('/api/twilio/sms', { From: '+15557770002', To: num, Body: 'Need a plumber tomorrow', NumMedia: '0', MessageSid: 'SM' + String(uid).padStart(32, '0') });
      const vmPath = `/api/twilio/voicemail?user_id=${uid}`;
      const rVm = await twilioPost(vmPath, { From: '+15557770003', CallSid: callSid(uid + 200), RecordingSid: 'RE' + 'a'.repeat(32), RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/RE${'a'.repeat(32)}` });
      await wait(120);
      const after = snapshot();
      ok(`T1 ${label}: inbound call is rejected before answer (busy), no Dial/Record, not re-routed`,
        r.status === 200 && /<Reject reason="busy"\/>/.test(vXml) && !/<Dial|<Record|<Client/.test(vXml));
      ok(`T2 ${label}: unanswered-call webhook hangs up without voicemail`, rMiss.status === 200 && /<Hangup\/>/.test(rMiss.text) && !/<Record/.test(rMiss.text));
      ok(`T3 ${label}: inbound SMS acknowledged (200) but nothing stored, analysed or notified`, rSms.status === 200
        && count('SELECT COUNT(*) n FROM messages WHERE user_id = ?', OWNER) === ownerMsgs);
      ok(`T4 ${label}: voicemail webhook acknowledged; no download, AI, lead or push`, rVm.status === 200 && /<Hangup\/>/.test(rVm.text));
      ok(`T5 ${label}: no rows created, no pushes, no downloads, no AI across all four webhooks`, same(before, after), JSON.stringify({ before, after }));
    }
    // /recording for a call that belonged to an account disabled mid-call
    db.prepare("INSERT INTO calls (from_number, call_sid, classification, user_id) VALUES ('+15557770004', ?, 'Lead', ?)").run(callSid(9001), SUS);
    let before = snapshot();
    r = await twilioPost('/api/twilio/recording', { CallSid: callSid(9001), RecordingSid: 'RE' + 'b'.repeat(32), RecordingDuration: '30' });
    await wait(120);
    const callRow = db.prepare('SELECT transcript, summary, recording_url FROM calls WHERE call_sid = ?').get(callSid(9001));
    ok('T6 answered-call recording for a disabled account: acknowledged (204), no download/AI, call row unchanged',
      r.status === 204 && same(before, snapshot()) && !callRow.transcript && !callRow.summary && !callRow.recording_url);
    before = snapshot();
    r = await twilioPost('/api/twilio/voice-client', { From: `client:user_${BLK}`, To: '+15557770005', CallSid: callSid(9002) });
    ok('T7 outgoing call from a blocked account (still-valid Voice token) is refused', r.status === 200 && /not active/.test(r.text) && !/<Dial/.test(r.text) && same(before, snapshot()));
    r = await twilioPost('/api/twilio/voice-client', { From: `client:user_${ACT}`, To: `client:user_${SUS}`, CallSid: callSid(9003) });
    ok('T8 in-app call to a suspended account\'s device is refused (bypasses /voice)', r.status === 200 && /not available/.test(r.text) && !/<Dial/.test(r.text) && same(before, snapshot()));
    const odd = [`client:user_${SUS} `, `client: user_${SUS}`, `client:user_${SUS}\n`, 'client:contractor', `client:user_0${SUS}x`];
    const oddRes = [];
    for (const [i, to] of odd.entries()) oddRes.push(await twilioPost('/api/twilio/voice-client', { From: `client:user_${ACT}`, To: to, CallSid: callSid(9100 + i) }));
    ok('T8b odd spellings of an in-app destination (spaces, newline, other identities) are refused, never dialled raw',
      oddRes.every(x => x.status === 200 && /not available/.test(x.text) && !/<Dial/.test(x.text)) && same(before, snapshot()));
    r = await twilioPost('/api/twilio/voice-client', { From: `client:user_${SUS}`.replace(String(SUS), String(SUS)), To: ` client:user_${ACT}`, CallSid: callSid(9110) });
    const rOk = await twilioPost('/api/twilio/voice-client', { From: `client:user_${ACT}`, To: `client:user_${OWNER} `, CallSid: callSid(9111) });
    ok('T8c an active destination is dialled by its normalised identity only', new RegExp(`<Client>user_${OWNER}</Client>`).test(rOk.text));
    // Controls: active account and unassigned number behave as before.
    r = await twilioPost('/api/twilio/voice', { From: '+15557770006', To: NUM.ACT, CallSid: callSid(9004), Direction: 'inbound' });
    await wait(80);
    ok('T9 control: active account still rings its own client and gets the push', new RegExp(`<Client>user_${ACT}</Client>`).test(r.text)
      && count('SELECT COUNT(*) n FROM calls WHERE call_sid = ? AND user_id = ?', callSid(9004), ACT) === 1 && sent.web.includes(DEV.ACT.endpoint));
    r = await twilioPost('/api/twilio/sms', { From: '+15557770007', To: NUM.ACT, Body: 'Quote please', NumMedia: '0', MessageSid: 'SM' + '7'.repeat(32) });
    await wait(80);
    ok('T10 control: active account still receives SMS (message + lead)', r.status === 200 && count('SELECT COUNT(*) n FROM messages WHERE user_id = ?', ACT) >= 1);
    r = await twilioPost('/api/twilio/voice', { From: '+15557770008', To: NUM.FREE, CallSid: callSid(9005), Direction: 'inbound' });
    ok('T11 control: unassigned-number routing is unchanged (owner)', new RegExp(`<Client>user_${OWNER}</Client>`).test(r.text));
    r = await twilioPost('/api/twilio/voice-client', { From: `client:user_${ACT}`, To: '+15557770009', CallSid: callSid(9006) });
    ok('T12 control: active account can still place calls', /<Dial/.test(r.text) && /<Number>\+15557770009<\/Number>/.test(r.text));
    setStatus(BLK, { status: 'tester' });
    r = await twilioPost('/api/twilio/voice', { From: '+15557770010', To: NUM.BLK, CallSid: callSid(9007), Direction: 'inbound' });
    ok('T13 reinstating an account restores inbound calls (reversible)', new RegExp(`<Client>user_${BLK}</Client>`).test(r.text));
    setStatus(BLK, { status: 'blocked' });

    // ── P. Push ───────────────────────────────────────────────────────────────
    before = snapshot();
    await pushService.sendPush(SUS, { title: 't', body: 'b' });
    await pushService.sendPush(BLK, { title: 't', body: 'b' });
    ok('P1 no push or FCM delivery to suspended/blocked accounts; their device rows are kept', same(before, snapshot())
      && count('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id IN (?,?)', SUS, BLK) === 2);
    await pushService.sendPush(ACT, { title: 't', body: 'b' });
    ok('P2 control: active account still receives push and FCM', sent.web.length > before.web && sent.fcm.length > before.fcm);

    // ── G. Gmail sync pause / resume ──────────────────────────────────────────
    const insTok = db.prepare('INSERT INTO gmail_tokens (email, access_token, refresh_token, user_id) VALUES (?,?,?,?)');
    insTok.run('act@example.test', 'AT-a', 'RT-a', ACT); insTok.run('sus@example.test', 'AT-s', 'RT-s', SUS); insTok.run('blk@example.test', 'AT-b', 'RT-b', BLK);
    const active = gmailSvc.getActiveConnectedUserIds();
    ok('G1 startup backfill list excludes suspended/blocked accounts', active.includes(ACT) && !active.includes(SUS) && !active.includes(BLK));
    const polled = [], synced = [];
    gmailSvc.getClient = (uid) => { polled.push(uid); return { users: { messages: { list: async () => ({ data: { messages: [] } }) } } }; };
    gmailSvc.syncRecentEmails = async (uid, o) => { synced.push({ uid, daysBack: o.daysBack }); };
    await poller.poll();
    const paused1 = db.prepare('SELECT user_id, sync_paused_at p FROM gmail_tokens ORDER BY user_id').all();
    ok('G2 the poller does not sync suspended/blocked accounts and records where their skipped window starts',
      polled.includes(ACT) && !polled.includes(SUS) && !polled.includes(BLK)
      && paused1.find(x => x.user_id === SUS).p > 0 && paused1.find(x => x.user_id === BLK).p > 0 && !paused1.find(x => x.user_id === ACT).p);
    await poller.poll();
    const paused2 = db.prepare('SELECT sync_paused_at p FROM gmail_tokens WHERE user_id = ?').get(SUS).p;
    ok('G3 the skipped-window start is kept across polls', paused2 === paused1.find(x => x.user_id === SUS).p);
    setStatus(SUS, { suspended: false });
    polled.length = 0;
    await poller.poll();
    ok('G4 on reinstatement the skipped window is backfilled once, then normal polling resumes',
      synced.length === 1 && synced[0].uid === SUS && synced[0].daysBack >= 1 && polled.includes(SUS)
      && db.prepare('SELECT sync_paused_at p FROM gmail_tokens WHERE user_id = ?').get(SUS).p === null);
    setStatus(SUS, { suspended: true });
    await poller.poll();
    db.prepare('UPDATE gmail_tokens SET sync_paused_at = ? WHERE user_id = ?').run(Date.now() - 40 * 864e5, SUS);
    setStatus(SUS, { suspended: false });
    await poller.poll();
    ok('G5 the resume backfill is capped at 30 days', synced[synced.length - 1].daysBack === 30);
    // A token refresh from a client built before a reconnect must not overwrite the new connection.
    const realLoad = gmailSvc.loadCredentials;
    const { client: oldClient } = realLoad(ACT);
    db.prepare("UPDATE gmail_tokens SET email = 'act-new@example.test', access_token = 'AT-new', refresh_token = 'RT-new' WHERE user_id = ?").run(ACT);
    oldClient.handlers.tokens({ access_token: 'AT-from-old-refresh', expiry_date: 1 });
    ok('G6 a late refresh of the previous Gmail token set never overwrites a newer connection',
      db.prepare('SELECT access_token a FROM gmail_tokens WHERE user_id = ?').get(ACT).a === 'AT-new');
    const { client: newClient } = realLoad(ACT);
    newClient.handlers.tokens({ access_token: 'AT-new-2', expiry_date: 2 });
    gmailSvc.invalidateToken(ACT, 'RT-a');
    const keptAfterOldInvalid = !!db.prepare('SELECT 1 FROM gmail_tokens WHERE user_id = ?').get(ACT);
    ok('G7 the current token set still refreshes; an invalid_grant for an OLD token set does not delete the new connection',
      db.prepare('SELECT access_token a FROM gmail_tokens WHERE user_id = ?').get(ACT)?.a === 'AT-new-2' && keptAfterOldInvalid);
    setStatus(SUS, { suspended: true });

    // ── O. Outbound + paid AI refuse disabled sessions ────────────────────────
    const tSus = mkSession(SUS), tBlk2 = mkSession(BLK);
    before = snapshot();
    const outs = [];
    for (const t of [tSus, tBlk2]) {
      outs.push(await req('GET', '/api/twilio/token', { token: t }));
      outs.push(await req('POST', '/api/messages/send', { token: mkSession(t === tSus ? SUS : BLK), json: { to: '+15557770011', body: 'hi' } }));
      outs.push(await req('POST', '/api/numbers/claim', { token: mkSession(t === tSus ? SUS : BLK), json: { phoneNumber: '+15557770012' } }));
      outs.push(await req('POST', '/api/translate', { token: mkSession(t === tSus ? SUS : BLK), json: { text: 'hello', targetLang: 'es' } }));
      outs.push(await req('POST', '/api/leads', { token: mkSession(t === tSus ? SUS : BLK), json: { transcript: 'Need a plumber' } }));
      outs.push(await req('POST', '/api/transcribe', { token: mkSession(t === tSus ? SUS : BLK) }));
    }
    ok('O1 voice token, SMS send, number claim, translation, manual transcript and transcription all refuse disabled sessions (401), with no AI call',
      outs.every(x => x.status === 401 && x.data?.code === 'ACCOUNT_DISABLED') && same(before, snapshot()), outs.map(x => x.status).join(','));

    // ── R. Translation limits ─────────────────────────────────────────────────
    // Limiters use fixed windows with a weighted previous window; a run that
    // straddles a window boundary can see ±1 attempt. Start well clear of one.
    { const W = 15 * 60e3, left = W - (Date.now() % W); if (left < 240e3) await new Promise(res => setTimeout(res, left + 1000)); }
    const TL = aiBudget.translateLimits;
    const clearAi = () => { Object.values(TL).forEach(l => l.clear()); Object.values(aiBudget.transcribeLimits).forEach(l => l.clear()); };
    clearAi();
    const tR = mkSession(UNK), tR2 = mkSession(TRI);
    const chat0 = sent.chat;
    const bad = [
      await req('POST', '/api/translate', { token: tR, json: { text: 42, targetLang: 'es' } }),
      await req('POST', '/api/translate', { token: tR, json: { text: 'hi', targetLang: 'fr' } }),
      await req('POST', '/api/translate', { token: tR, json: { text: 'hi', targetLang: '__proto__' } }),
      await req('POST', '/api/translate', { token: tR, json: { text: 'hi', targetLang: 'constructor' } }),
      await req('POST', '/api/translate', { token: tR, json: { text: '   ', targetLang: 'es' } }),
    ];
    const big = await req('POST', '/api/translate', { token: tR, json: { text: 'z'.repeat(5001), targetLang: 'es' } });
    ok('R1 malformed input and unsupported languages are rejected (400) without an AI call or using budget',
      bad.every(x => x.status === 400) && sent.chat === chat0 && TL.accountHour.size() === 0 && aiBudget.aiGlobalDay.size() === 0);
    ok('R2 oversized text is rejected (413) before any AI call', big.status === 413 && sent.chat === chat0);
    const PROBE = 'PRIVATE-PROBE-TEXT-' + crypto.randomBytes(4).toString('hex');
    let okN = 0, last = null;
    for (let i = 0; i < 31; i++) { last = await req('POST', '/api/translate', { token: tR, json: { text: `${PROBE} ${i}`, targetLang: 'es' } }); if (last.status === 200) okN++; }
    ok('R3 30 translations per hour per account; the 31st gets a generic 429 with Retry-After', okN === 30 && last.status === 429
      && last.data?.error === 'Translation limit reached. Please try again later.' && Number(last.headers.get('retry-after')) > 0 && sent.chat === chat0 + 30);
    ok('R4 submitted text is never logged or echoed in the limit response', !logged.some(l => l.includes(PROBE)) && !last.text.includes(PROBE));
    r = await req('POST', '/api/translate', { token: tR2, json: { text: 'hola', targetLang: 'en' } });
    ok('R5 the limit is per account (another account is unaffected)', r.status === 200);
    clearAi();
    let dayOk = 0;
    for (let i = 0; i < 151; i++) { if (i && i % 30 === 0) TL.accountHour.clear(); const x = await req('POST', '/api/translate', { token: tR, json: { text: 'hi', targetLang: 'es' } }); if (x.status === 200) dayOk++; last = x; }
    ok('R6 150 translations per day per account; the 151st is refused', dayOk === 150 && last.status === 429);
    clearAi();
    for (let i = 0; i < 30; i++) TL.accountHour.hit(String(TRI));
    r = await req('POST', '/api/leads', { token: tR2, json: { transcript: 'Need a plumber' } });
    ok('R7 exhausting translation does not consume the transcription budget (separate per-account budgets)', r.status !== 429);
    clearAi();
    for (let i = 0; i < 1000; i++) aiBudget.aiGlobalDay.hit('all');
    const gT = await req('POST', '/api/translate', { token: mkSession(OWNER), json: { text: 'hi', targetLang: 'es' } });
    const gL = await req('POST', '/api/leads', { token: mkSession(OWNER), json: { transcript: 'Need a plumber' } });
    ok('R8 one global paid-AI ceiling covers translation AND transcription across all accounts', gT.status === 429 && gL.status === 429);
    clearAi();
    const ERRPROBE = 'org-SECRETPROBE quota details';
    aiFail.next = ERRPROBE;
    r = await req('POST', '/api/leads', { token: mkSession(OWNER), json: { transcript: 'Need a plumber' } });
    aiFail.next = null;
    ok('R9 an AI failure on a manual transcript returns generic text; provider message never echoed or logged',
      r.status === 500 && !r.text.includes('SECRETPROBE') && !logged.some(l => l.includes('SECRETPROBE')));
    clearAi();

    // ── H. Expired-session housekeeping ───────────────────────────────────────
    db.prepare('DELETE FROM sessions').run();
    const ins = (token, exp) => db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, OWNER, exp);
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    const sqlUtc = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);
    ins('h-old', iso(-8 * 864e5)); ins('h-grace', iso(-6 * 864e5)); ins('h-soon', iso(2000)); ins('h-live', iso(3600e3));
    ins('h-legacy-old', sqlUtc(-9 * 864e5)); ins('h-legacy-today-future', sqlUtc(30 * 60e3)); ins('h-nomillis-old', iso(-10 * 864e5).replace(/\.\d{3}Z$/, 'Z'));
    ins('h-garbage', 'not-a-date');
    let removed = await hk.purgeExpiredSessions();
    const left = new Set(db.prepare('SELECT token FROM sessions').all().map(x => x.token));
    ok('H1 default run removes only rows expired more than the 7-day grace; active and in-grace rows stay',
      removed === 3 && !left.has('h-old') && !left.has('h-legacy-old') && !left.has('h-nomillis-old')
      && left.has('h-grace') && left.has('h-soon') && left.has('h-live') && left.has('h-legacy-today-future'), `removed=${removed}`);
    ok('H2 unparseable expiry values are never deleted by cleanup (and never authenticate)', left.has('h-garbage') && session.lookupSession('h-garbage') === null);
    // A legacy-format row on the cutoff DATE but inside the grace must be kept
    // (the text range alone would include it; the julianday() grace test decides).
    db.prepare('DELETE FROM sessions').run();
    const graceMs = hk.SESSION_GRACE_SECONDS * 1000;
    ins('g-legacy-in-grace', sqlUtc(-graceMs + 60e3));
    ins('g-legacy-past-grace', sqlUtc(-graceMs - 60e3));
    await hk.purgeExpiredSessions();
    const leftG = new Set(db.prepare('SELECT token FROM sessions').all().map(x => x.token));
    ok('H2b a legacy-format row expired just inside the 7-day grace is kept; one just past it is removed',
      leftG.has('g-legacy-in-grace') && !leftG.has('g-legacy-past-grace'));
    db.prepare('DELETE FROM sessions').run();
    ins('b-past1s', iso(-1000)); ins('b-future1s', iso(1500)); ins('b-past10ms', iso(-10)); ins('b-future-legacy', sqlUtc(65e3));
    removed = await hk.purgeExpiredSessions({ graceSeconds: 0 });
    const left2 = new Set(db.prepare('SELECT token FROM sessions').all().map(x => x.token));
    ok('H3 boundary with zero grace: just-expired rows go, rows expiring in ~1s stay and still authenticate',
      !left2.has('b-past1s') && !left2.has('b-past10ms') && left2.has('b-future1s') && left2.has('b-future-legacy')
      && session.lookupSession('b-future1s') !== null && session.lookupSession('b-future-legacy') !== null, `removed=${removed}`);
    // No active session can ever be removed: every row lookupSession accepts survives any run.
    db.prepare('DELETE FROM sessions').run();
    const mixed = [];
    for (let i = 0; i < 400; i++) { const ms = (i - 200) * 997; const t = `m-${i}`; ins(t, i % 3 ? iso(ms) : sqlUtc(ms)); mixed.push(t); }
    const activeBefore = mixed.filter(t => session.lookupSession(t));
    await hk.purgeExpiredSessions({ graceSeconds: 0 });
    ok('H4 a zero-grace run over 400 mixed-format rows (±200 s) never removes a row that still authenticates',
      activeBefore.every(t => count('SELECT COUNT(*) n FROM sessions WHERE token = ?', t) === 1) && activeBefore.length > 100);
    db.prepare('DELETE FROM sessions').run();
    const many = db.transaction(() => { for (let i = 0; i < 1200; i++) ins(`x-${i}`, iso(-8 * 864e5 - i * 1000)); });
    many();
    removed = await hk.purgeExpiredSessions({ batchSize: 500, maxBatches: 2 });
    const rest = count('SELECT COUNT(*) n FROM sessions');
    const removed2 = await hk.purgeExpiredSessions({ batchSize: 500, maxBatches: 2 });
    ok('H5 each run is bounded (batch × max batches) and later runs finish the backlog', removed === 1000 && rest === 200 && removed2 === 200);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT token FROM sessions WHERE expires_at < ? AND julianday(expires_at) <= julianday('now','-600 seconds') LIMIT 500`).all('2026-01-01T00:00:00.000Z');
    ok('H6 cleanup uses the expires_at index (range search, not a full scan)', plan.some(p => /idx_sessions_expires/.test(p.detail)) && !plan.some(p => /^SCAN sessions$/.test(p.detail)), plan.map(p => p.detail).join(' | '));
    const exp = mkSession(ACT, -3600e3);
    r = await req('GET', '/api/whoami', { token: exp });
    ok('H7 requests never purge (no per-request scan): an expired token is refused but its row is left for housekeeping', r.status === 401 && count('SELECT COUNT(*) n FROM sessions WHERE token = ?', exp) === 1);
    logged.length = 0;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(iso(-8 * 864e5), exp);
    const exp2 = mkSession(ACT, -9 * 864e5);
    await hk.runHousekeeping();
    ok('H8 housekeeping logs counts only (no tokens)', logged.some(l => /\[Housekeeping\] expired sessions: removed \d+/.test(l)) && !logged.some(l => l.includes(exp) || l.includes(exp2)));

    // Concurrency (in-process): many authenticated requests racing repeated cleanup runs.
    db.prepare('DELETE FROM sessions').run();
    const racers = Array.from({ length: 60 }, (_, i) => mkSession(ACT, 3000 + i * 400));
    for (let i = 0; i < 300; i++) ins(`dead-${i}`, iso(-864e5));
    let stop = false, runs = 0;
    const purgeLoop = (async () => { while (!stop) { await hk.purgeExpiredSessions({ graceSeconds: 0, batchSize: 25, maxBatches: 2 }); runs++; await new Promise(res => setImmediate(res)); } })();
    const results = await Promise.all(racers.map(t => req('GET', '/api/whoami', { token: t })));
    stop = true; await purgeLoop;
    ok('H9 60 concurrent requests during repeated cleanup runs: all authenticate, no active row removed',
      results.every(x => x.status === 200) && racers.every(t => count('SELECT COUNT(*) n FROM sessions WHERE token = ?', t) === 1) && runs > 1, `runs=${runs}`);

    // Concurrency (cross-process): another process writes and reads sessions in the same DB while we purge.
    const child = spawn(process.execPath, ['-e', `
      console.log = () => {};
      process.env.DB_PATH = ${JSON.stringify(TMP)};
      const crypto = require('crypto');
      const db = require(${JSON.stringify(path.join(BE, 'db'))});
      const { lookupSession } = require(${JSON.stringify(path.join(BE, 'utils/session'))});
      const mine = []; let errors = 0; const end = Date.now() + 1500;
      (async () => {
        while (Date.now() < end) {
          try {
            const t = crypto.randomBytes(16).toString('hex');
            db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(t, ${ACT}, new Date(Date.now() + 60000).toISOString());
            db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('cx-' + t, ${ACT}, new Date(Date.now() - 86400000).toISOString());
            mine.push(t);
            if (!lookupSession(t)) errors++;
          } catch (e) { errors++; }
          await new Promise(r => setImmediate(r));
        }
        process.stdout.write(JSON.stringify({ mine, errors }));
      })();
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', c => { out += c; });
    const childClosed = new Promise(res => child.on('close', res));     // attach now: the child may exit first
    let parentRuns = 0, parentErr = 0;
    const until = Date.now() + 1500;
    while (Date.now() < until) { try { await hk.purgeExpiredSessions({ graceSeconds: 0, batchSize: 50, maxBatches: 1 }); parentRuns++; } catch { parentErr++; } await wait(5); }
    await childClosed;
    const childRes = JSON.parse(out || '{"mine":[],"errors":-1}');
    ok('H10 cross-process: cleanup racing another process\'s logins causes no errors and removes none of its active sessions',
      childRes.errors === 0 && parentErr === 0 && childRes.mine.length > 20
      && childRes.mine.every(t => count('SELECT COUNT(*) n FROM sessions WHERE token = ?', t) === 1), `child=${childRes.mine.length} runs=${parentRuns}`);

    // Time zones: identical outcome in every server time zone (incl. DST-observing and non-hour offsets).
    const tzScript = (dbPath) => `
      console.log = () => {};
      process.env.DB_PATH = ${JSON.stringify('__DB__')}.replace('__DB__', ${JSON.stringify(dbPath)});
      const db = require(${JSON.stringify(path.join(BE, 'db'))});
      const { lookupSession } = require(${JSON.stringify(path.join(BE, 'utils/session'))});
      const hk = require(${JSON.stringify(path.join(BE, 'jobs/housekeeping'))});
      const uid = db.prepare("INSERT INTO users (email, display_name) VALUES ('tz@example.test','tz')").run().lastInsertRowid;
      const iso = (ms) => new Date(Date.now() + ms).toISOString();
      const sqlUtc = (ms) => iso(ms).replace('T', ' ').slice(0, 19);
      const rows = { isoPast: iso(-120000), isoFuture: iso(120000), legacyPast: sqlUtc(-7200000), legacyFuture: sqlUtc(7200000), isoGrace: iso(-300000) };
      for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(k, uid, v);
      const valid = Object.keys(rows).filter(k => lookupSession(k));
      hk.purgeExpiredSessions({ graceSeconds: 60 }).then(n => {
        const left = db.prepare('SELECT token FROM sessions ORDER BY token').all().map(r => r.token);
        process.stdout.write(JSON.stringify({ valid: valid.sort(), removed: n, left, offset: new Date().getTimezoneOffset() }));
      });`;
    const zones = ['UTC', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata', 'Pacific/Chatham', 'America/St_Johns'];
    const tzOut = zones.map(z => {
      const p = path.join(os.tmpdir(), `plumbline-tz-${process.pid}-${z.replace(/\W/g, '_')}.db`);
      cleanupDb(p);
      try { return JSON.parse(execFileSync(process.execPath, ['-e', tzScript(p)], { env: { ...process.env, TZ: z }, encoding: 'utf8' })); }
      finally { cleanupDb(p); }
    });
    const ref = JSON.stringify({ valid: tzOut[0].valid, removed: tzOut[0].removed, left: tzOut[0].left });
    ok('H11 identical validity and cleanup results in 6 server time zones (DST and non-DST, :30/:45 offsets)',
      tzOut.every(o => JSON.stringify({ valid: o.valid, removed: o.removed, left: o.left }) === ref)
      && new Set(tzOut.map(o => o.offset)).size >= 4
      && same(tzOut[0].valid, ['isoFuture', 'legacyFuture']) && same(tzOut[0].left, ['isoFuture', 'legacyFuture']), ref);

    // ── F. Frontend Gmail return module (src/oauthReturn.js) in a fake browser ─
    const ORET = path.join(BE, '..', 'frontend', 'src', 'oauthReturn.js');
    const runReturn = (href, { framed = false } = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      const u = new URL(${JSON.stringify(href)});
      const calls = [];
      const win = { location: { href: u.href, hash: u.hash, search: u.search, pathname: u.pathname, origin: u.origin },
        history: { state: null, replaceState: (s, t, url) => { calls.push(url); const n = new URL(url, u.origin); win.location.hash = n.hash; win.location.search = n.search; win.location.href = n.href; } } };
      win.self = win; win.top = ${framed ? '{}' : 'win'};
      globalThis.window = win;
      const m = await import(${JSON.stringify('file://' + ORET)});
      process.stdout.write(JSON.stringify({ handle: m.getGmailHandle(), seen: m.sawGmailHandle(), ret: m.hasGmailReturn(), err: m.getGmailError(),
        calls, hash: win.location.hash, scrub: m.scrubUrl(${JSON.stringify(href)}) }));`], { encoding: 'utf8' }));
    const H = 'A'.repeat(21) + '_' + 'b'.repeat(21);
    let o = runReturn(`https://app.example.test/#gmail_complete=${H}`);
    ok('F1 a valid completion handle is captured in memory and removed from the address bar immediately',
      o.handle === H && o.seen && o.hash === '' && o.calls.length === 1 && !o.calls[0].includes(H) && !o.scrub.includes(H));
    const oq = runReturn('https://app.example.test/api/calls/rec.mp3?token=SESSIONSECRET#x');
    ok('F1b the Sentry URL scrubber removes query strings (session tokens in media URLs) and fragments', oq.scrub === 'https://app.example.test/api/calls/rec.mp3');
    o = runReturn('https://app.example.test/#gmail_complete=<script>');
    ok('F2 a malformed handle is stripped and ignored', o.handle === null && o.seen && o.hash === '');
    o = runReturn(`https://app.example.test/#gmail_complete=${H}`, { framed: true });
    ok('F3 inside a frame the handle is stripped and ignored (cannot be claimed by a framing page)', o.handle === null && o.hash === '');
    o = runReturn('https://app.example.test/?gmail_error=state_invalid');
    const o2 = runReturn('https://app.example.test/?gmail_error=%3Cx%3E');
    const o3 = runReturn('https://app.example.test/');
    ok('F4 error returns are recognised; odd values ignored; a normal load is untouched', o.err === 'state_invalid' && o.ret && o2.err === null && !o3.ret && o3.calls.length === 0);
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
