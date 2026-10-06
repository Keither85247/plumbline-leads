'use strict';
/**
 * DEF-3 + DEF-8 security tests (RELEASE_READINESS_TEST_REPORT.md): account
 * isolation and public-surface hardening.
 *
 *   A. Public /api/health is liveness-only; /api/health/env and /owner are
 *      owner-only (anonymous 401, tester 403) and leak no account data.
 *   B. /api/transcribe requires a session, ignores body-supplied user ids,
 *      and never creates ownerless leads; createLeadFromTranscript refuses a
 *      missing owner.
 *   C. Push delivery targets only the intended account's subscriptions (no
 *      NULL-owner fan-out, no broadcast); push routes require a session and
 *      cannot delete another account's rows; logout removes this device only.
 *   D. Inbound SMS/voice: lead association, duplicate/same-day checks and
 *      caller classification use only the receiving account's data; lead
 *      message counts are per-account; owner status does not bypass isolation.
 *   E. Calls: ensure-logged neither reveals nor modifies another account's
 *      call; the phone fallback cannot claim ownerless rows; an answered-call
 *      recording with no owned call row creates nothing.
 *   F. /api/migrate is owner-only and stamps imported rows with the owner.
 *   G. index.js wiring: public/owner/auth mount order.
 *
 * Hermetic: own temp SQLite DB, synthetic accounts, OpenAI / Gmail / web-push /
 * Firebase stubbed, no network, no production data.
 *
 * Run:  node backend/scripts/test-account-isolation.js
 * Exit: 0 = all pass, 1 = any failure.
 */
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');
const Module = require('module');

// ── Hermetic DB + env ────────────────────────────────────────────────────────
const BE  = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `plumbline-isolation-test-${process.pid}.db`);
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.DB_PATH = TMP;
process.env.DATA_DIR = path.join(os.tmpdir(), `plumbline-isolation-data-${process.pid}`);

const AUTH_TOKEN = 'test_auth_token_' + crypto.randomBytes(8).toString('hex');
const BASE_URL   = 'https://backend.example.onrender.com';
process.env.TWILIO_ACCOUNT_SID   = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN    = AUTH_TOKEN;
process.env.TWILIO_BASE_URL      = BASE_URL;
process.env.TWILIO_PHONE_NUMBER  = '+15550000000';
process.env.TWILIO_TWIML_APP_SID = 'AP' + '0'.repeat(32);
process.env.OPENAI_API_KEY       = 'sk-test-not-used';
process.env.VAPID_PUBLIC_KEY     = 'test-vapid-public';
process.env.VAPID_PRIVATE_KEY    = 'test-vapid-private';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
delete process.env.NODE_ENV;
delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;

// ── Stubs (record what would leave the server) ───────────────────────────────
const sentWebEndpoints = [];
const sentFcmTokens    = [];
let   whisperCalls     = 0;
let   nextCategory     = 'Lead';
let   recordingDownloads = 0;
const { PassThrough, EventEmitter } = (() => { const st = require('stream'); return { PassThrough: st.PassThrough, EventEmitter: require('events') }; })();
const fakeHttps = {
  // Mimics a successful Twilio media download so /recording reaches its
  // persistence logic (otherwise a failed download would mask regressions).
  get(url, opts, cb) {
    recordingDownloads++;
    const req = new EventEmitter();
    setImmediate(() => {
      const res = new PassThrough();
      res.statusCode = 200;
      cb(res);
      res.end(Buffer.from('fake-mp3-bytes'));
    });
    return req;
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'https' && parent && /routes[\\/]twilio\.js$/.test(parent.filename)) return fakeHttps;
  if (request === 'openai') {
    return class OpenAI {
      constructor() {
        this.audio = { transcriptions: { create: async ({ file } = {}) => {
          whisperCalls++;
          if (file && typeof file[Symbol.asyncIterator] === 'function') { for await (const _ of file) { /* consume like the real SDK upload */ } }
          return { text: 'Hi, I need a quote for a leaking pipe.' };
        } } };
        this.chat = { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
          contactName: 'Pat', companyName: '', category: nextCategory, summary: 'Pat – needs a quote',
          keyPoints: ['Leaking pipe'], callbackNumber: '', followUpText: 'Hi Pat',
        }) } }] }) } };
      }
    };
  }
  if (request === 'web-push') {
    return {
      setVapidDetails: () => {},
      sendNotification: async (sub) => { sentWebEndpoints.push(sub.endpoint); return {}; },
    };
  }
  if (request === 'firebase-admin') {
    const admin = {
      apps: [],
      initializeApp() { admin.apps.push({}); },
      credential: { cert: () => ({}) },
      messaging: () => ({
        sendEachForMulticast: async (m) => {
          sentFcmTokens.push(...m.tokens);
          return { successCount: m.tokens.length, responses: m.tokens.map(() => ({ success: true })) };
        },
      }),
    };
    return admin;
  }
  if (request === 'googleapis') {
    return { google: { auth: { OAuth2: function () { return {}; } } } };
  }
  return origLoad.apply(this, arguments);
};
const gmailPath = require.resolve(path.join(BE, 'services/gmailService.js'));
require.cache[gmailPath] = {
  id: gmailPath, filename: gmailPath, loaded: true,
  exports: { oauth2Client: {}, syncRecentEmails: async () => {}, isConnected: () => false },
};

const express      = require(path.join(BE, 'node_modules/express'));
const cookieParser = require(path.join(BE, 'node_modules/cookie-parser'));
const twilio       = require(path.join(BE, 'node_modules/twilio'));
const db           = require(path.join(BE, 'db'));
// Test-DB fix-up only: on a brand-new database the existing contacts migration
// in db.js fails ("no such column: user_id"), leaving the legacy contacts table
// (no id / user_id / UNIQUE(user_id, phone)). Production DBs were migrated
// incrementally and already have the new schema. Tracked separately; here the
// EMPTY test table is rebuilt with the schema db.js migrates to.
if (!db.prepare('PRAGMA table_info(contacts)').all().some(c => c.name === 'user_id')) {
  db.exec(`
    DROP TABLE IF EXISTS contacts_new;
    DROP TABLE contacts;
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id),
      phone TEXT NOT NULL, name TEXT, address TEXT, email TEXT, notes TEXT,
      preferred_contact_method TEXT, formatted_address TEXT, address_line_1 TEXT,
      city TEXT, state TEXT, postal_code TEXT, country TEXT, lat REAL, lng REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      company TEXT, contact_type TEXT NOT NULL DEFAULT 'Lead',
      UNIQUE(user_id, phone)
    );`);
}

// ── Harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ── Seed accounts (OWNER is a real owner — proves no owner bypass) ──────────
function mkUser(email, isOwner) {
  return Number(db.prepare('INSERT INTO users (email, display_name, is_owner) VALUES (?,?,?)').run(email, email, isOwner ? 1 : 0).lastInsertRowid);
}
function mkSession(userId) {
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(t, userId, new Date(Date.now() + 3600_000).toISOString());
  return t;
}
const OWNER = mkUser('owner@test.local', true);
const A     = mkUser('a@test.local', false);
const B     = mkUser('b@test.local', false);
const tOwner = mkSession(OWNER), tA = mkSession(A), tB = mkSession(B);

const NUM_A = '+15551110001', NUM_B = '+15552220002', NUM_OWNER = '+15553330003';
const insNum = db.prepare('INSERT INTO phone_numbers (phone_number, twilio_sid, assigned_user_id) VALUES (?,?,?)');
insNum.run(NUM_A, 'PN' + 'a'.repeat(32), A);
insNum.run(NUM_B, 'PN' + 'b'.repeat(32), B);
insNum.run(NUM_OWNER, 'PN' + 'c'.repeat(32), OWNER);

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const count = (sql, ...p) => db.prepare(sql).get(...p).n;

async function run() {
  const health        = require(path.join(BE, 'routes/health'));
  const requireAuth   = require(path.join(BE, 'middleware/requireAuth'));
  const requireOwner  = require(path.join(BE, 'middleware/requireOwner'));
  const authRouter    = require(path.join(BE, 'routes/auth'));
  const twilioRouter  = require(path.join(BE, 'routes/twilio'));
  const leadsRouter   = require(path.join(BE, 'routes/leads'));
  const callsRouter   = require(path.join(BE, 'routes/calls'));
  const pushRouter    = require(path.join(BE, 'routes/push'));
  const transcribe    = require(path.join(BE, 'routes/transcribe'));
  const migrateRouter = require(path.join(BE, 'routes/migrate'));
  const messagesRouter = require(path.join(BE, 'routes/messages'));
  const countsRouter  = require(path.join(BE, 'routes/counts'));
  const { sendPush }  = require(path.join(BE, 'services/pushService'));
  const { createLeadFromTranscript } = require(path.join(BE, 'routes/leads'));

  // Mirror backend/index.js mount order (section G verifies index.js itself).
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/health', health.publicRouter);
  app.use('/auth', authRouter);
  app.use('/api/twilio', twilioRouter);
  app.use(requireAuth);
  app.use('/api/leads', leadsRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/counts', countsRouter);
  app.use('/api/transcribe', transcribe);
  app.use('/api/health', requireOwner, health.ownerRouter);
  app.use('/api/migrate', migrateRouter);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const req = async (method, p, { token, json, form, headers } = {}) => {
    const h = { ...(headers || {}), ...(token ? auth(token) : {}) };
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const r = await fetch(base + p, { method, headers: h, body });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, text, data };
  };
  const twilioPost = async (p, params) => {
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, BASE_URL + p, params);
    return req('POST', p, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
      form: new URLSearchParams(params).toString(),
    });
  };

  try {
    // ── A. Health ───────────────────────────────────────────────────────────
    let r = await req('GET', '/api/health');
    ok('A1 public /api/health → 200 {ok:true} only', r.status === 200 && r.text === '{"ok":true}', r.text);
    r = await req('GET', '/api/health/owner');
    ok('A2 anonymous /api/health/owner → 401, no account data', r.status === 401 && !/@|owner_email|total_users|owner_id/.test(r.text), `${r.status} ${r.text}`);
    r = await req('GET', '/api/health/env');
    ok('A3 anonymous /api/health/env → 401, no config', r.status === 401 && !/ALLOW_PUBLIC_SIGNUP|NODE_ENV/.test(r.text), `${r.status}`);
    r = await req('GET', '/api/health/owner', { token: tA });
    ok('A4 tester /api/health/owner → 403, no account data', r.status === 403 && !/@|owner_email/.test(r.text), `${r.status}`);
    r = await req('GET', '/api/health/env', { token: tA });
    ok('A5 tester /api/health/env → 403', r.status === 403, `${r.status}`);
    r = await req('GET', '/api/health/owner', { token: tOwner });
    ok('A6 owner /api/health/owner → 200 diagnostics', r.status === 200 && r.data?.owner_exists === true, `${r.status}`);

    // ── B. Transcription ────────────────────────────────────────────────────
    const leadsBefore = count('SELECT COUNT(*) n FROM leads');
    const mkForm = () => {
      const f = new FormData();
      f.append('audio', new Blob([Buffer.from('fake-audio')], { type: 'audio/mpeg' }), 'clip.mp3');
      f.append('userId', String(B));      // must be ignored
      f.append('user_id', String(B));     // must be ignored
      return f;
    };
    const whisperBefore = whisperCalls;
    r = await req('POST', '/api/transcribe', { form: mkForm() });
    ok('B1 anonymous /api/transcribe → 401', r.status === 401, `${r.status}`);
    ok('B2 anonymous transcribe creates no lead and calls no paid API',
      count('SELECT COUNT(*) n FROM leads') === leadsBefore && whisperCalls === whisperBefore);
    r = await req('POST', '/api/transcribe', { token: tA, form: mkForm() });
    const created = r.data?.lead?.id ? db.prepare('SELECT user_id FROM leads WHERE id = ?').get(r.data.lead.id) : null;
    ok('B3 authenticated transcribe → 201, lead owned by caller (body user id ignored)',
      r.status === 201 && created?.user_id === A, `${r.status} owner=${created?.user_id}`);
    ok('B4 no ownerless leads exist', count('SELECT COUNT(*) n FROM leads WHERE user_id IS NULL') === 0);
    let threw = false;
    const before = count('SELECT COUNT(*) n FROM leads');
    try { await createLeadFromTranscript({ transcript: 'x', rawText: 'x', userId: null }); } catch { threw = true; }
    ok('B5 createLeadFromTranscript refuses a missing owner (no row)', threw && count('SELECT COUNT(*) n FROM leads') === before);

    // ── C. Push ─────────────────────────────────────────────────────────────
    const insWeb = db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'a')");
    const insFcm = db.prepare('INSERT INTO fcm_subscriptions (user_id, fcm_token) VALUES (?, ?)');
    insWeb.run(A, 'https://push.test/a1'); insWeb.run(A, 'https://push.test/a2'); insWeb.run(A, 'https://push.test/a3');
    insWeb.run(B, 'https://push.test/b1'); insWeb.run(null, 'https://push.test/orphan');
    insWeb.run(OWNER, 'https://push.test/owner1');
    insFcm.run(A, 'fcm-a'); insFcm.run(B, 'fcm-b'); insFcm.run(null, 'fcm-orphan');

    const reset = () => { sentWebEndpoints.length = 0; sentFcmTokens.length = 0; };
    reset(); await sendPush(A, { title: 't', body: 'b' });
    ok('C1 sendPush(A) targets only A web subscriptions',
      JSON.stringify([...sentWebEndpoints].sort()) === JSON.stringify(['https://push.test/a1', 'https://push.test/a2', 'https://push.test/a3']),
      sentWebEndpoints.join(','));
    ok('C2 sendPush(A) targets only A FCM tokens (no orphan/foreign)', JSON.stringify(sentFcmTokens) === '["fcm-a"]', sentFcmTokens.join(','));
    reset(); await sendPush(null, { title: 't', body: 'b' }); await sendPush(undefined, { title: 't', body: 'b' });
    ok('C3 sendPush(null/undefined) sends nothing (no broadcast)', sentWebEndpoints.length === 0 && sentFcmTokens.length === 0);
    reset(); await sendPush(OWNER, { title: 't', body: 'b' });
    ok('C4 owner receives only owner subscriptions (no owner bypass)', JSON.stringify(sentWebEndpoints) === '["https://push.test/owner1"]' && sentFcmTokens.length === 0);

    r = await req('POST', '/api/push/subscribe', { json: { endpoint: 'https://push.test/x', keys: { p256dh: 'k', auth: 'a' } } });
    ok('C5 anonymous push subscribe → 401 (no row)', r.status === 401 && count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = 'https://push.test/x'") === 0);
    r = await req('POST', '/api/push/fcm-subscribe', { json: { fcmToken: 'fcm-anon' } });
    ok('C6 anonymous FCM subscribe → 401 (no row)', r.status === 401 && count("SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = 'fcm-anon'") === 0);
    r = await req('DELETE', '/api/push/subscribe', { token: tB, json: { endpoint: 'https://push.test/a1' } });
    ok('C7 B cannot delete A web subscription', count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = 'https://push.test/a1' AND user_id = ?", A) === 1);
    r = await req('DELETE', '/api/push/fcm-subscribe', { token: tB, json: { fcmToken: 'fcm-a' } });
    ok('C8 B cannot delete A FCM token', count("SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = 'fcm-a' AND user_id = ?", A) === 1);

    // Logout removes THIS device only, and only rows the session owns.
    const tA2 = mkSession(A);
    r = await req('POST', '/auth/logout', { token: tA2, json: { pushEndpoint: 'https://push.test/a1', fcmToken: 'fcm-a' } });
    ok('C9 logout removes this device web subscription', r.status === 200 && count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = 'https://push.test/a1'") === 0);
    ok('C10 logout removes this device FCM token', count("SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = 'fcm-a'") === 0);
    ok('C11 logout keeps A other devices', count('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', A) === 2);
    ok('C12 logout session is deleted', count('SELECT COUNT(*) n FROM sessions WHERE token = ?', tA2) === 0);
    const tA3 = mkSession(A);
    await req('POST', '/auth/logout', { token: tA3, json: { pushEndpoint: 'https://push.test/b1', fcmToken: 'fcm-b' } });
    ok('C13 logout cannot remove another account device', count("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = 'https://push.test/b1' AND user_id = ?", B) === 1
      && count("SELECT COUNT(*) n FROM fcm_subscriptions WHERE fcm_token = 'fcm-b' AND user_id = ?", B) === 1);
    reset(); await sendPush(A, { title: 't', body: 'b' });
    ok('C14 after logout, logged-out device no longer targeted', !sentWebEndpoints.includes('https://push.test/a1') && !sentFcmTokens.includes('fcm-a'));

    // ── D. Inbound SMS / voice isolation ────────────────────────────────────
    const P = '+15557770007';
    const bLead = Number(db.prepare(
      "INSERT INTO leads (transcript, raw_text, summary, contact_name, phone_number, category, source, archived, user_id, created_at) VALUES ('B secret thread', 'B secret thread', 's', 'B contact', ?, 'Spam', 'sms', 0, ?, ?)"
    ).run(P, B, nowIso()).lastInsertRowid);
    const bLeadBefore = JSON.stringify(db.prepare('SELECT * FROM leads WHERE id = ?').get(bLead));
    const aLeadsBefore = count('SELECT COUNT(*) n FROM leads WHERE user_id = ?', A);
    r = await twilioPost('/api/twilio/sms', { From: P, To: NUM_A, Body: 'B secret thread', NumMedia: '0', MessageSid: 'SM' + '1'.repeat(32) });
    const aMsg = db.prepare('SELECT * FROM messages WHERE user_id = ? AND phone = ? ORDER BY id DESC LIMIT 1').get(A, P);
    ok('D1 inbound SMS to A stored for A only', r.status === 200 && !!aMsg && count('SELECT COUNT(*) n FROM messages WHERE user_id = ? AND phone = ?', B, P) === 0);
    ok('D2 SMS not associated with B lead', aMsg?.lead_id !== bLead, `lead_id=${aMsg?.lead_id}`);
    ok('D3 B duplicate/same-day lead does not suppress A lead', count('SELECT COUNT(*) n FROM leads WHERE user_id = ?', A) === aLeadsBefore + 1);
    ok('D4 B lead unchanged', JSON.stringify(db.prepare('SELECT * FROM leads WHERE id = ?').get(bLead)) === bLeadBefore);
    // Positive control: A's OWN recent lead does suppress a same-day duplicate.
    const aCountMid = count('SELECT COUNT(*) n FROM leads WHERE user_id = ?', A);
    db.prepare("UPDATE leads SET created_at = ? WHERE user_id = ? AND phone_number = ?").run(nowIso(), A, P);
    await twilioPost('/api/twilio/sms', { From: P, To: NUM_A, Body: 'second text', NumMedia: '0', MessageSid: 'SM' + '2'.repeat(32) });
    ok('D5 control: A own same-day lead still de-duplicates', count('SELECT COUNT(*) n FROM leads WHERE user_id = ?', A) === aCountMid);

    // Owner does not bypass: owner's lead for P2 doesn't suppress/associate B.
    const P2 = '+15558880008';
    db.prepare("INSERT INTO leads (transcript, raw_text, summary, phone_number, category, source, archived, user_id, created_at) VALUES ('owner thread', 'owner thread', 's', ?, 'Lead', 'sms', 0, ?, ?)").run(P2, OWNER, nowIso());
    const bBefore = count('SELECT COUNT(*) n FROM leads WHERE user_id = ?', B);
    await twilioPost('/api/twilio/sms', { From: P2, To: NUM_B, Body: 'owner thread', NumMedia: '0', MessageSid: 'SM' + '3'.repeat(32) });
    ok('D6 owner lead does not suppress tester lead (no owner bypass)', count('SELECT COUNT(*) n FROM leads WHERE user_id = ?', B) === bBefore + 1);

    // D2b: A has a same-day lead for P5, B has a MORE RECENT lead for P5.
    // The inbound text must be associated with A's lead, never B's.
    const P5 = '+15554440004';
    const later = new Date(Date.now() + 1000).toISOString();
    const aLead5 = Number(db.prepare("INSERT INTO leads (transcript, raw_text, summary, phone_number, category, source, archived, user_id, created_at) VALUES ('a5', 'a5', 's', ?, 'Lead', 'sms', 0, ?, ?)").run(P5, A, nowIso()).lastInsertRowid);
    const bLead5 = Number(db.prepare("INSERT INTO leads (transcript, raw_text, summary, phone_number, category, source, archived, user_id, created_at) VALUES ('b5', 'b5', 's', ?, 'Lead', 'sms', 0, ?, ?)").run(P5, B, later).lastInsertRowid);
    await twilioPost('/api/twilio/sms', { From: P5, To: NUM_A, Body: 'follow up text', NumMedia: '0', MessageSid: 'SM' + '4'.repeat(32) });
    const m5 = db.prepare('SELECT lead_id FROM messages WHERE user_id = ? AND phone = ? ORDER BY id DESC LIMIT 1').get(A, P5);
    ok('D2b inbound text associated with A lead, not B more-recent lead', m5?.lead_id === aLead5 && m5?.lead_id !== bLead5, `lead_id=${m5?.lead_id}`);

    // D3b: A has only an OLD lead for P6; B has a same-day lead for P6.
    // B's same-day lead must not suppress A's new lead.
    const P6 = '+15553330003';
    const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    db.prepare("INSERT INTO leads (transcript, raw_text, summary, phone_number, category, source, archived, user_id, created_at) VALUES ('a6', 'a6', 's', ?, 'Lead', 'sms', 0, ?, ?)").run(P6, A, old);
    db.prepare("INSERT INTO leads (transcript, raw_text, summary, phone_number, category, source, archived, user_id, created_at) VALUES ('b6', 'b6', 's', ?, 'Lead', 'sms', 0, ?, ?)").run(P6, B, nowIso());
    const a6Before = count('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND phone_number = ?', A, P6);
    await twilioPost('/api/twilio/sms', { From: P6, To: NUM_A, Body: 'new job request', NumMedia: '0', MessageSid: 'SM' + '5'.repeat(32) });
    ok('D3b B same-day lead does not suppress A new lead', count('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND phone_number = ?', A, P6) === a6Before + 1);

    // Classification: B labelled P as Spam; a call from P to A must not be.
    insFcm.run(A, 'fcm-a2');
    reset();
    r = await twilioPost('/api/twilio/voice', { From: P, To: NUM_A, CallSid: 'CA' + 'd'.repeat(32), Direction: 'inbound' });
    const aCall = db.prepare('SELECT * FROM calls WHERE call_sid = ?').get('CA' + 'd'.repeat(32));
    ok('D7 call to A classified from A data only (not B Spam)', r.status === 200 && aCall?.user_id === A && aCall?.classification !== 'Likely Spam', `class=${aCall?.classification}`);
    await sleep(50);
    ok('D8 incoming-call push goes to A devices only (web + FCM)',
      sentWebEndpoints.length > 0 && sentWebEndpoints.every(e => e.startsWith('https://push.test/a'))
      && sentFcmTokens.length > 0 && sentFcmTokens.every(t => t === 'fcm-a2'),
      `web=${sentWebEndpoints.join(',')} fcm=${sentFcmTokens.join(',')}`);
    // Control: A's own Spam history does classify.
    const P3 = '+15559990009';
    db.prepare("INSERT INTO leads (transcript, raw_text, summary, phone_number, category, source, archived, user_id) VALUES ('spam', 'spam', 's', ?, 'Spam', 'sms', 0, ?)").run(P3, A);
    await twilioPost('/api/twilio/voice', { From: P3, To: NUM_A, CallSid: 'CA' + 'e'.repeat(32), Direction: 'inbound' });
    ok('D9 control: A own Spam history still classifies', db.prepare('SELECT classification FROM calls WHERE call_sid = ?').get('CA' + 'e'.repeat(32))?.classification === 'Likely Spam');

    // Message counts are per-account.
    const P4 = '+15556660006';
    db.prepare("INSERT INTO leads (transcript, raw_text, summary, phone_number, category, source, archived, user_id) VALUES ('a4', 'a4', 's', ?, 'Lead', 'sms', 0, ?)").run(P4, A);
    const insMsg = db.prepare("INSERT INTO messages (phone, direction, body, status, user_id) VALUES (?, 'inbound', ?, 'received', ?)");
    db.prepare("INSERT INTO messages (phone, direction, body, status, user_id, created_at) VALUES (?, 'inbound', 'mine', 'received', ?, '2026-01-01 10:00:00')").run(P4, A);
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO messages (phone, direction, body, status, user_id, created_at) VALUES (?, 'inbound', ?, 'received', ?, '2026-06-01 10:00:00')").run(P4, 'B private ' + i, B);
    r = await req('GET', '/api/leads', { token: tA });
    const list = Array.isArray(r.data) ? r.data : (r.data?.leads || []);
    const l4 = list.find(l => l.phone_number === P4);
    ok('D10 lead message_count counts only own messages', l4?.message_count === 1, `count=${l4?.message_count}`);
    ok('D10b lead last_message_at uses only own messages', l4?.last_message_at === '2026-01-01 10:00:00', `last=${l4?.last_message_at}`);
    ok('D11 lead list contains no other account leads', list.length > 0 && list.every(l => l.user_id === A));
    r = await req('GET', '/api/leads', { token: tOwner });
    const ownerList = Array.isArray(r.data) ? r.data : (r.data?.leads || []);
    ok('D12 owner lead list contains only owner leads (no owner bypass)', r.status === 200 && ownerList.length > 0 && ownerList.every(l => l.user_id === OWNER), `status=${r.status} n=${ownerList.length}`);

    // D13/D14: a newer ownerless message for the same phone must not hide A's
    // conversation or unread count.
    const P7 = '+15552220007';
    db.prepare("INSERT INTO messages (phone, direction, body, status, is_read, user_id, created_at) VALUES (?, 'inbound', 'A unread', 'received', 0, ?, '2026-02-01 10:00:00')").run(P7, A);
    const texts0 = (await req('GET', '/api/counts', { token: tA })).data?.texts;
    db.prepare("INSERT INTO messages (phone, direction, body, status, is_read, user_id, created_at) VALUES (?, 'inbound', 'orphan', 'received', 0, NULL, '2026-03-01 10:00:00')").run(P7);
    r = await req('GET', '/api/messages', { token: tA });
    const convo = Array.isArray(r.data) ? r.data.find(c => c.phone === P7) : null;
    ok('D13 ownerless newer message does not hide A conversation', r.status === 200 && !!convo && !/orphan/.test(r.text), `status=${r.status}`);
    const texts1 = (await req('GET', '/api/counts', { token: tA })).data?.texts;
    ok('D14 ownerless newer message does not change A unread count', typeof texts0 === 'number' && texts1 === texts0, `before=${texts0} after=${texts1}`);

    // ── E. Calls ────────────────────────────────────────────────────────────
    const sidB = 'CA' + 'b'.repeat(32);
    db.prepare("INSERT INTO calls (from_number, call_sid, classification, user_id) VALUES ('+15550001111', ?, 'Outbound', ?)").run(sidB, B);
    const bCallBefore = JSON.stringify(db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(sidB));
    r = await req('POST', '/api/calls/ensure-logged', { token: tA, json: { callSid: sidB, phone: '+15552223333' } });
    ok('E1 ensure-logged on foreign call reveals no id', r.status === 200 && r.data && !('id' in r.data), r.text);
    ok('E2 ensure-logged does not modify foreign call', JSON.stringify(db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(sidB)) === bCallBefore);
    const sidOrphan = 'CA' + '7'.repeat(32);
    const orphanCallId = Number(db.prepare("INSERT INTO calls (from_number, call_sid, classification, user_id) VALUES (NULL, ?, 'Outbound', NULL)").run(sidOrphan).lastInsertRowid);
    r = await req('POST', '/api/calls/ensure-logged', { token: tA, json: { callSid: sidOrphan, phone: '+15552223333' } });
    const oc = db.prepare('SELECT user_id, from_number FROM calls WHERE id = ?').get(orphanCallId);
    ok('E1b ensure-logged neither reveals nor claims an ownerless call', r.data && !('id' in r.data) && oc.user_id === null && oc.from_number === null, JSON.stringify(oc));
    await req('POST', '/api/calls/outbound-note', { token: tA, json: { callSid: sidOrphan, note: 'claim?' } });
    const oc2 = db.prepare('SELECT user_id, contractor_note FROM calls WHERE id = ?').get(orphanCallId);
    ok('E1c outbound-note by CallSid cannot claim an ownerless call', oc2.user_id === null && oc2.contractor_note === null, JSON.stringify(oc2));
    r = await req('POST', '/api/calls/ensure-logged', { token: tA, json: { callSid: 'CA' + 'f'.repeat(32), phone: '+15552223333' } });
    ok('E3 ensure-logged on own new call creates A row', r.data?.created === true && db.prepare('SELECT user_id FROM calls WHERE call_sid = ?').get('CA' + 'f'.repeat(32))?.user_id === A);
    const orphanId = Number(db.prepare("INSERT INTO calls (from_number, classification, user_id) VALUES ('+15554445555', 'Outbound', NULL)").run().lastInsertRowid);
    await req('POST', '/api/calls/outbound-note', { token: tA, json: { phone: '+15554445555', note: 'mine?' } });
    const orphan = db.prepare('SELECT user_id, contractor_note FROM calls WHERE id = ?').get(orphanId);
    ok('E4 phone fallback cannot claim an ownerless call', orphan.user_id === null && orphan.contractor_note === null, JSON.stringify(orphan));
    // E7 first: positive control proves the stubbed download path persists
    // data for an OWNED call (so E5/E6 cannot pass vacuously).
    const sidOwned = 'CA' + '8'.repeat(32);
    db.prepare("INSERT INTO calls (from_number, call_sid, classification, user_id) VALUES ('+15551234567', ?, 'Outbound', ?)").run(sidOwned, A);
    r = await twilioPost('/api/twilio/recording', { CallSid: sidOwned, RecordingSid: 'RE' + '8'.repeat(32), RecordingDuration: '5' });
    await sleep(150);
    const owned = db.prepare('SELECT user_id, transcript FROM calls WHERE call_sid = ?').get(sidOwned);
    ok('E7 control: recording for an owned call is transcribed onto that call', r.status === 204 && owned.user_id === A && !!owned.transcript, JSON.stringify(owned));
    const whisperB4 = whisperCalls, dlB4 = recordingDownloads;
    const callsB4 = count('SELECT COUNT(*) n FROM calls');
    r = await twilioPost('/api/twilio/recording', { CallSid: 'CA' + '9'.repeat(32), RecordingSid: 'RE' + '9'.repeat(32), RecordingDuration: '5' });
    await sleep(150);
    ok('E5 recording without a call row creates nothing (no download/AI)', r.status === 204 && count('SELECT COUNT(*) n FROM calls') === callsB4 && whisperCalls === whisperB4 && recordingDownloads === dlB4);
    r = await twilioPost('/api/twilio/recording', { CallSid: sidOrphan, RecordingSid: 'RE' + '7'.repeat(32), RecordingDuration: '5' });
    await sleep(150);
    const oc3 = db.prepare('SELECT user_id, transcript FROM calls WHERE id = ?').get(orphanCallId);
    ok('E6 recording for an ownerless call row stores nothing', oc3.user_id === null && oc3.transcript === null && whisperCalls === whisperB4, JSON.stringify(oc3));

    // E9/E10: vendor voicemail enriches only the receiving account's call row.
    nextCategory = 'Vendor';
    const sidVmOwned = 'CA' + '5'.repeat(32), sidVmOrphan = 'CA' + '4'.repeat(32);
    db.prepare("INSERT INTO calls (from_number, call_sid, classification, user_id) VALUES ('+15550202020', ?, 'Unknown', ?)").run(sidVmOwned, A);
    const vmOrphanId = Number(db.prepare("INSERT INTO calls (from_number, call_sid, classification, user_id) VALUES ('+15550303030', ?, 'Unknown', NULL)").run(sidVmOrphan).lastInsertRowid);
    await twilioPost(`/api/twilio/voicemail?user_id=${A}`, { From: '+15550202020', CallSid: sidVmOwned, RecordingSid: 'RE' + '5'.repeat(32) });
    await sleep(200);
    ok('E9 control: vendor voicemail enriches A own call row', !!db.prepare('SELECT transcript FROM calls WHERE call_sid = ?').get(sidVmOwned)?.transcript);
    await twilioPost(`/api/twilio/voicemail?user_id=${A}`, { From: '+15550303030', CallSid: sidVmOrphan, RecordingSid: 'RE' + '4'.repeat(32) });
    await sleep(200);
    const vmo = db.prepare('SELECT user_id, transcript FROM calls WHERE id = ?').get(vmOrphanId);
    ok('E10 vendor voicemail does not write into an ownerless call row', vmo.user_id === null && vmo.transcript === null, JSON.stringify(vmo));
    nextCategory = 'Lead';

    // E8: voicemail with a malformed owner id creates nothing.
    const leadsVm = count('SELECT COUNT(*) n FROM leads');
    const whisperVm = whisperCalls, dlVm = recordingDownloads;
    r = await twilioPost('/api/twilio/voicemail?user_id=abc', { From: '+15550101010', CallSid: 'CA' + '6'.repeat(32), RecordingSid: 'RE' + '6'.repeat(32) });
    await sleep(150);
    ok('E8 voicemail without a valid owning account creates nothing', r.status === 200 && count('SELECT COUNT(*) n FROM leads') === leadsVm && whisperCalls === whisperVm && recordingDownloads === dlVm);

    // ── F. Migrate ──────────────────────────────────────────────────────────
    const lead = { user_id: B, id: 900001, transcript: 't', raw_text: 't', contact_name: 'm', company_name: '', phone_number: '+15550009999', callback_number: null, summary: '', key_points: '[]', follow_up_text: '', category: 'Lead', source: 'voicemail', recording_url: null, status: 'new', archived: 0, created_at: '2026-01-01 00:00:00' };
    const call = { user_id: B, id: 900001, from_number: '+15550009999', call_sid: null, classification: 'Unknown', status: 'completed', recording_url: null, duration: null, transcript: null, summary: null, key_points: null, contractor_note: null, outcome: null, created_at: '2026-01-01 00:00:00' };
    r = await req('POST', '/api/migrate', { json: { leads: [lead], calls: [call] } });
    ok('F1 anonymous /api/migrate → 401', r.status === 401);
    r = await req('POST', '/api/migrate', { token: tA, json: { leads: [lead], calls: [call] } });
    ok('F2 tester /api/migrate → 403, nothing inserted', r.status === 403 && count('SELECT COUNT(*) n FROM leads WHERE id = 900001') === 0);
    r = await req('POST', '/api/migrate', { token: tOwner, json: { leads: [lead], calls: [call] } });
    ok('F3 owner /api/migrate → 200, rows owned by owner (body user_id ignored)', r.status === 200
      && db.prepare('SELECT user_id FROM leads WHERE id = 900001').get()?.user_id === OWNER
      && db.prepare('SELECT user_id FROM calls WHERE id = 900001').get()?.user_id === OWNER);

    // ── G. index.js wiring ──────────────────────────────────────────────────
    const src = fs.readFileSync(path.join(BE, 'index.js'), 'utf8');
    const at = (s) => src.indexOf(s);
    const iPublic = at("app.use('/api/health', healthRouters.publicRouter)");
    const iAuth   = at('app.use(requireAuth);');
    const iOwnerH = at("app.use('/api/health', requireOwner, healthRouters.ownerRouter)");
    const iTrans  = at("app.use('/api/transcribe', transcribeRouter)");
    const iMig    = at("app.use('/api/migrate', migrateRouter)");
    ok('G1 index.js: public health before requireAuth', iPublic > 0 && iAuth > iPublic);
    ok('G2 index.js: owner diagnostics, transcribe, migrate after requireAuth', iOwnerH > iAuth && iTrans > iAuth && iMig > iAuth);
    ok('G3 index.js: no inline public health diagnostics remain', !/app\.(get|use|all)\(\s*['"`]\/api\/health\/(owner|env)/.test(src));
  } catch (err) {
    fail++; console.log('FAIL  harness error —', err.stack || err.message);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {}
    process.exit(fail === 0 ? 0 : 1);
  }
}

run();
