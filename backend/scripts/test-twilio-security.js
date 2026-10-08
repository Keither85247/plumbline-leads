'use strict';
/**
 * DEF-2 security tests: Twilio webhook signature validation, retired paid-call
 * endpoint, recording-URL SSRF hardening, owner-only diagnostics, and the
 * dev-only bypass fail-safe.
 *
 * Hermetic: own temp SQLite DB, heavy/paid deps (OpenAI, pushService) stubbed
 * in the require cache, no network, no real Twilio/OpenAI/Render calls. Valid
 * signatures are produced with Twilio's official getExpectedTwilioSignature so
 * the tests exercise the exact algorithm Twilio uses.
 *
 * Run:  node backend/scripts/test-twilio-security.js
 * Exit: 0 = all pass, 1 = any failure.
 */
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const crypto = require('crypto');
const Module = require('module');

// ── Config / hermetic DB ─────────────────────────────────────────────────────
const BE = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `plumbline-twilio-test-${process.pid}.db`);
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.DB_PATH = TMP;

const ACCOUNT_SID = 'AC' + '0'.repeat(32);
const AUTH_TOKEN  = 'test_auth_token_' + crypto.randomBytes(8).toString('hex');
const BASE_URL    = 'https://backend.example.onrender.com';
process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
process.env.TWILIO_AUTH_TOKEN  = AUTH_TOKEN;
process.env.TWILIO_BASE_URL    = BASE_URL;
process.env.TWILIO_PHONE_NUMBER = '+15550000000';
process.env.TWILIO_TWIML_APP_SID = 'AP' + '0'.repeat(32);
process.env.OPENAI_API_KEY = 'sk-test-not-used';
delete process.env.NODE_ENV;                 // dev-like unless a test overrides
delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;

// ── Stub heavy/paid deps so the real twilio router loads fast & side-effect free
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'openai') {
    return class OpenAI { constructor() { this.audio = { transcriptions: { create: async () => ({ text: '' }) } }; this.chat = { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } }; } };
  }
  return origLoad.apply(this, arguments);
};
// Stub pushService (firebase / web-push) by resolved path
const pushPath = require.resolve(path.join(BE, 'services/pushService.js'));
require.cache[pushPath] = { id: pushPath, filename: pushPath, loaded: true, exports: { sendPush: async () => {} } };

const express = require(path.join(BE, 'node_modules/express'));
const twilio  = require(path.join(BE, 'node_modules/twilio'));
const db      = require(path.join(BE, 'db'));

// ── Test harness ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { (cond ? pass++ : fail++); console.log(`${cond?'PASS':'FAIL'}  ${name}${extra?'  — '+extra:''}`); };

function sign(url, params) {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params || {});
}
async function post(base, urlPath, { sig, form } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sig !== undefined) headers['X-Twilio-Signature'] = sig;
  const body = new URLSearchParams(form || {}).toString();
  const res = await fetch(`${base}${urlPath}`, { method: 'POST', headers, body });
  let text = ''; try { text = await res.text(); } catch {}
  return { status: res.status, text };
}

async function run() {
  // Fresh require of the REAL twilio router (after env + stubs are set)
  const twilioRouter = require(path.join(BE, 'routes/twilio'));
  const { assertSafeRecordingUrl, resolveSafeRecordingUrl, canonicalRecordingUrl } = require(path.join(BE, 'utils/twilioRecording'));
  const verifyTwilioSignature = require(path.join(BE, 'middleware/verifyTwilioSignature'));

  const app = express();
  app.use('/api/twilio', twilioRouter);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  try {
    // ───────────────────────── Part B: signature validation ─────────────────
    const voicePath = '/api/twilio/voice';
    const voiceForm = { From: '+15551234567', To: process.env.TWILIO_PHONE_NUMBER, CallSid: 'CA' + '1'.repeat(32) };
    const signedUrl = BASE_URL + voicePath;               // canonical URL Twilio signs

    const callsBefore = () => db.prepare('SELECT COUNT(*) c FROM calls').get().c;

    // 1. Missing signature → 403, no DB write
    let n0 = callsBefore();
    let r = await post(BASE, voicePath, { form: voiceForm }); // no X-Twilio-Signature
    ok('1. missing signature → 403', r.status === 403);
    ok('5a. missing-sig caused no calls row', callsBefore() === n0, `before=${n0} after=${callsBefore()}`);

    // 2. Invalid signature → 403, no DB write
    n0 = callsBefore();
    r = await post(BASE, voicePath, { sig: 'totally-wrong-signature', form: voiceForm });
    ok('2. invalid signature → 403', r.status === 403);
    ok('5b. invalid-sig caused no calls row', callsBefore() === n0);

    // 3 + 4. Correct signature for exact URL + form body → accepted (200 TwiML) + behavior retained (call logged)
    // With no account at all there is no verified owner: the call is refused
    // (valid TwiML, so Twilio does not retry) and no ownerless row is created.
    n0 = callsBefore();
    const goodSig = sign(signedUrl, voiceForm);
    r = await post(BASE, voicePath, { sig: goodSig, form: voiceForm });
    ok('4c. valid request with no owning account → refused TwiML, no ownerless calls row',
      r.status === 200 && /<Reject/.test(r.text) && callsBefore() === n0);
    if (!db.prepare('SELECT id FROM users WHERE is_owner=1 LIMIT 1').get()) {
      db.prepare("INSERT INTO users (email,is_owner) VALUES ('o@t.local',1)").run();
    }
    n0 = callsBefore();
    r = await post(BASE, voicePath, { sig: goodSig, form: voiceForm });
    ok('3. correct signature accepted → 200', r.status === 200, `status=${r.status}`);
    ok('4. valid request retains behavior (TwiML returned)', /<Response>/.test(r.text) && /<Dial/.test(r.text));
    ok('4b. valid request performed its DB write (call logged)', callsBefore() === n0 + 1);

    // 3c. Signature validity is URL-specific: a signature for a different path is rejected
    const wrongPathSig = sign(BASE_URL + '/api/twilio/other', voiceForm);
    r = await post(BASE, voicePath, { sig: wrongPathSig, form: voiceForm });
    ok('3c. signature bound to URL (wrong-URL sig → 403)', r.status === 403);

    // 3d. Query-string webhook: /voicemail?user_id=N signed over the full URL incl. query
    //     Assert it is ACCEPTED (proves query params are handled). Downloads are
    //     skipped because we send no RecordingUrl/RecordingSid → handler returns early.
    const ownerId = db.prepare('SELECT id FROM users WHERE is_owner=1 LIMIT 1').get()?.id
                 || db.prepare("INSERT INTO users (email,is_owner) VALUES ('o@t.local',1)").run().lastInsertRowid;
    const vmPath = `/api/twilio/voicemail?user_id=${ownerId}`;
    const vmForm = { From: '+15551112222', CallSid: 'CA' + '2'.repeat(32) }; // no recording → no download
    const vmSig = sign(BASE_URL + vmPath, vmForm);
    r = await post(BASE, vmPath, { sig: vmSig, form: vmForm });
    ok('3d. query-string URL signature accepted (200)', r.status === 200, `status=${r.status}`);
    const vmMissingSig = await post(BASE, vmPath, { form: vmForm });
    ok('3e. query-string URL missing sig → 403', vmMissingSig.status === 403);

    // ───────────────────────── Part A: retired paid endpoint ─────────────────
    // 6. /outbound cannot initiate a call without auth → 410 (no auth accepted at all)
    const outRes = await fetch(`${BASE}/api/twilio/outbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: '+15559998888' }),
    });
    ok('6. /outbound unauthenticated → 410 (cannot initiate call)', outRes.status === 410, `status=${outRes.status}`);
    // 7. source proof: twilio.js never calls client.calls.create() IN CODE.
    // Strip block + line comments first so explanatory prose that mentions the
    // retired API does not trip the check.
    const twilioSrcCode = fs.readFileSync(path.join(BE, 'routes/twilio.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/.*$/gm, '');          // line comments
    ok('7. twilio.js contains no calls.create() in code', !/\.calls\.create\s*\(/.test(twilioSrcCode));

    // ───────────────────────── Part C: recording URL safety ─────────────────
    const RE = 'RE' + 'a'.repeat(32);
    const goodRecUrl = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`;
    const rejects = [
      ['8. attacker host rejected',              'https://attacker.example/x.mp3'],
      ['9. lookalike host rejected',             `https://api.twilio.com.attacker.example/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`],
      ['10a. http rejected',                     `http://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`],
      ['10b. localhost rejected',                `https://localhost/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`],
      ['10c. private IP rejected',               `https://10.0.0.5/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`],
      ['10d. metadata IP rejected',              `https://169.254.169.254/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`],
      ['10e. credentials-in-URL rejected',       `https://api.twilio.com@evil.example/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`],
      ['10f. nonstandard port rejected',         `https://api.twilio.com:8443/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`],
      ['10g. userinfo lookalike rejected',       `https://api.twilio.com.evil.example:443/x`],
      ['10h. wrong account SID in path rejected',`https://api.twilio.com/2010-04-01/Accounts/AC${'9'.repeat(32)}/Recordings/${RE}`],
      ['10i. non-recording path rejected',       `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${RE}`],
      ['10j. malformed url rejected',            'not-a-url'],
    ];
    for (const [label, url] of rejects) {
      let threw = false;
      try { assertSafeRecordingUrl(url); } catch { threw = true; }
      ok(label, threw, threw ? '' : `ACCEPTED unsafe url: ${url}`);
    }
    // 11. legitimate recording for the configured account accepted → normalized .mp3
    let acceptedUrl = null; let acceptThrew = false;
    try { acceptedUrl = assertSafeRecordingUrl(goodRecUrl); } catch { acceptThrew = true; }
    ok('11. legit Twilio recording accepted', !acceptThrew && acceptedUrl === `${goodRecUrl}.mp3`, `got=${acceptedUrl}`);
    // 12. credentials attach only to approved destinations: resolver output is always api.twilio.com https
    const fromSid = canonicalRecordingUrl(RE);
    ok('12a. RecordingSid derives canonical api.twilio.com URL', fromSid === `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}.mp3`);
    let resolvedForAttacker = null, resolveThrew = false;
    try { resolvedForAttacker = resolveSafeRecordingUrl({ recordingUrl: 'https://attacker.example/x' }); } catch { resolveThrew = true; }
    ok('12b. resolver refuses attacker URL (no SID)', resolveThrew && resolvedForAttacker === null);
    // Preference: a valid RecordingSid wins even if a malicious URL is also supplied
    const pref = resolveSafeRecordingUrl({ recordingSid: RE, recordingUrl: 'https://attacker.example/x' });
    ok('12c. RecordingSid preferred over supplied URL', pref === `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}.mp3`);

    // ───────────────────────── Part D: owner-only diagnostics ────────────────
    // /diag is requireAuth + requireOwner. Anonymous → 401.
    const diagAnon = await fetch(`${BASE}/api/twilio/diag`);
    ok('14a. /diag anonymous → 401', diagAnon.status === 401, `status=${diagAnon.status}`);
    // Seed a normal tester + session → 403 (requireOwner)
    const testerId = db.prepare("INSERT INTO users (email,is_owner) VALUES ('t@t.local',0)").run().lastInsertRowid;
    const tTok = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(tTok, testerId, new Date(Date.now()+3600e3).toISOString());
    const diagTester = await fetch(`${BASE}/api/twilio/diag`, { headers: { Authorization: `Bearer ${tTok}` } });
    ok('14b. /diag as normal tester → 403', diagTester.status === 403, `status=${diagTester.status}`);
    // 14c. Owner PASSES the guard. We assert this against the SAME guard pair
    // (requireAuth + requireOwner) that gates /diag, on a no-op route — hitting
    // the real /diag as owner would make a live Twilio API call, which tests
    // must never do. Anon/tester rejection is already proven on the real route.
    const oTok = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(oTok, ownerId, new Date(Date.now()+3600e3).toISOString());
    const requireAuth  = require(path.join(BE, 'middleware/requireAuth'));
    const requireOwner = require(path.join(BE, 'middleware/requireOwner'));
    const guardApp = express();
    guardApp.get('/diag-guard', requireAuth, requireOwner, (_req, res) => res.json({ ok: true }));
    const guardSrv = guardApp.listen(0); await new Promise(r => guardSrv.once('listening', r));
    const guardBase = `http://127.0.0.1:${guardSrv.address().port}`;
    const gAnon   = await fetch(`${guardBase}/diag-guard`);
    const gTester = await fetch(`${guardBase}/diag-guard`, { headers: { Authorization: `Bearer ${tTok}` } });
    const gOwner  = await fetch(`${guardBase}/diag-guard`, { headers: { Authorization: `Bearer ${oTok}` } });
    guardSrv.close();
    ok('14c. owner guard: anon 401 / tester 403 / owner 200',
       gAnon.status === 401 && gTester.status === 403 && gOwner.status === 200,
       `anon=${gAnon.status} tester=${gTester.status} owner=${gOwner.status}`);

    // ───────────────────────── Part B: dev bypass fail-safe ──────────────────
    // 15. Bypass cannot activate in production.
    {
      const savedEnv = process.env.NODE_ENV;
      const savedByp = process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;
      process.env.NODE_ENV = 'production';
      process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = 'true';
      // Call the middleware directly with a fake req that has NO signature.
      let statusCode = null;
      const req = { header: () => undefined, method: 'POST', body: {}, originalUrl: '/api/twilio/voice', path: '/voice' };
      const res = { status(c){ statusCode = c; return { json(){ return this; }, send(){ return this; } }; } };
      let nextCalled = false;
      verifyTwilioSignature(req, res, () => { nextCalled = true; });
      ok('15a. prod ignores dev bypass (missing sig still 403)', statusCode === 403 && !nextCalled, `status=${statusCode} next=${nextCalled}`);

      // And in dev, the bypass DOES let it through (documented behavior)
      process.env.NODE_ENV = '';   // non-production
      let nextCalled2 = false, statusCode2 = null;
      const res2 = { status(c){ statusCode2 = c; return { json(){return this;}, send(){return this;} }; } };
      verifyTwilioSignature({ header: () => undefined, method: 'POST', body: {}, originalUrl: '/api/twilio/voice', path: '/voice' }, res2, () => { nextCalled2 = true; });
      ok('15b. dev bypass allows through when explicitly enabled', nextCalled2 === true && statusCode2 === null);

      process.env.NODE_ENV = savedEnv; if (savedEnv === undefined) delete process.env.NODE_ENV;
      if (savedByp === undefined) delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION; else process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = savedByp;
    }

    // ───────────────────────── point 13: playback proxy user_id scoping ──────
    // calls.js /:id/recording must still enforce user_id. Mount it behind a fake
    // auth that sets req.userId, seed two users' calls, assert cross-account 404.
    delete require.cache[require.resolve(path.join(BE, 'routes/calls'))];
    const callsRouter = require(path.join(BE, 'routes/calls'));
    const uA = db.prepare("INSERT INTO users (email,is_owner) VALUES ('ra@t.local',0)").run().lastInsertRowid;
    const uB = db.prepare("INSERT INTO users (email,is_owner) VALUES ('rb@t.local',0)").run().lastInsertRowid;
    const callB = db.prepare("INSERT INTO calls (from_number,call_sid,classification,recording_url,user_id) VALUES ('+15550001111','CA"+'3'.repeat(32)+"','Outbound',?,?)")
      .run(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RE}`, uB).lastInsertRowid;
    const appC = express();
    appC.use((req,_res,nx)=>{ req.userId = uA; nx(); });   // authenticated as user A
    appC.use('/api/calls', callsRouter);
    const srvC = appC.listen(0); await new Promise(r=>srvC.once('listening', r));
    const baseC = `http://127.0.0.1:${srvC.address().port}`;
    const crossRes = await fetch(`${baseC}/api/calls/${callB}/recording`);
    ok('13. calls recording proxy enforces user_id (A→B call = 404)', crossRes.status === 404, `status=${crossRes.status}`);
    srvC.close();

  } catch (err) {
    fail++; console.log('FAIL  harness error —', err.stack || err.message);
  } finally {
    server.close();
    try { db.close(); } catch {}
    for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

run();
