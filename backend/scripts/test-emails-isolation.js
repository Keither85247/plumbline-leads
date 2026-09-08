'use strict';
/**
 * Focused isolation test for DEF-1: cross-account email disclosure via
 * PATCH /api/emails/:id (and the adjacent GET/DELETE :id routes).
 *
 * Hermetic: builds its own throwaway SQLite DB in the OS temp dir (never the
 * dev/prod database), seeds two accounts, and drives the REAL emails router
 * behind the REAL requireAuth middleware over HTTP. No production data, no
 * network, no new dependencies. The Gmail/googleapis modules are stubbed only
 * so routes/emails.js can be required without its slow, unrelated dep tree.
 *
 * Run:  node backend/scripts/test-emails-isolation.js
 * Exit: 0 = all pass, 1 = any failure.
 */
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const crypto = require('crypto');
const Module = require('module');

// ── Hermetic DB ---------------------------------------------------------------
const TMP = path.join(os.tmpdir(), `plumbline-emails-test-${process.pid}.db`);
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.DB_PATH = TMP;

// ── Stub Gmail/googleapis so routes/emails.js requires quickly ---------------
const BE = path.join(__dirname, '..');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'googleapis') {
    return { google: { auth: { OAuth2: function () { return {}; } } } };
  }
  return origLoad.apply(this, arguments);
};
const gmailPath = require.resolve(path.join(BE, 'services/gmailService.js'));
require.cache[gmailPath] = {
  id: gmailPath, filename: gmailPath, loaded: true,
  exports: { isConnected: () => false, sendEmail: async () => ({}) },
};

// ── Real modules under test ---------------------------------------------------
const express     = require(path.join(BE, 'node_modules/express'));
const cookieParser= require(path.join(BE, 'node_modules/cookie-parser'));
const db          = require(path.join(BE, 'db'));
const requireAuth = require(path.join(BE, 'middleware/requireAuth'));
const emailsRouter= require(path.join(BE, 'routes/emails'));

// ── Seed two accounts, sessions, one email each -------------------------------
// A is the OWNER (to prove owner status does NOT bypass ownership scoping).
const userA = db.prepare("INSERT INTO users (email, display_name, is_owner) VALUES ('a@test.local','A',1)").run().lastInsertRowid;
const userB = db.prepare("INSERT INTO users (email, display_name, is_owner) VALUES ('b@test.local','B',0)").run().lastInsertRowid;
const tokenA = crypto.randomBytes(16).toString('hex');
const tokenB = crypto.randomBytes(16).toString('hex');
const exp = new Date(Date.now() + 3600_000).toISOString();
db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(tokenA, userA, exp);
db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(tokenB, userB, exp);
const A_SECRET = 'A private subject';
const B_SECRET = 'B PRIVATE subject';
const emailA = db.prepare(
  "INSERT INTO emails (direction,subject,body_preview,status,is_read,user_id) VALUES ('inbound',?, 'A secret body','received',0,?)"
).run(A_SECRET, userA).lastInsertRowid;
const emailB = db.prepare(
  "INSERT INTO emails (direction,subject,body_preview,status,is_read,user_id) VALUES ('inbound',?, 'B secret body','received',0,?)"
).run(B_SECRET, userB).lastInsertRowid;

// ── App ----------------------------------------------------------------------
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use(requireAuth);
app.use('/api/emails', emailsRouter);

// ── Assertions ----------------------------------------------------------------
let pass = 0, fail = 0;
const ok  = (name, cond, extra='') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function req(method, id, token, body) {
  const res = await fetch(`${BASE}/api/emails/${id}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, raw: JSON.stringify(json || {}) };
}

let BASE;
const server = app.listen(0, async () => {
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1. A can update and receive A's own email
    const r1 = await req('PATCH', emailA, tokenA, { is_read: true });
    ok('1. A updates own email → 200 + own row', r1.status === 200 && r1.json?.id === emailA && r1.json?.subject === A_SECRET, `status=${r1.status}`);
    const aReadNow = db.prepare('SELECT is_read FROM emails WHERE id=?').get(emailA).is_read;
    ok('   A own email actually updated (is_read=1)', aReadNow === 1);

    // 2. A cannot update B's email → 404
    const r2 = await req('PATCH', emailB, tokenA, { is_read: true });
    ok('2. A (owner) PATCH B email → 404', r2.status === 404);

    // 3. A does not receive B's content in the response
    ok('3. response leaks no B content', !r2.raw.includes(B_SECRET) && !r2.raw.includes('B secret body'), `body=${r2.raw.slice(0,80)}`);

    // 4. B's stored email is unchanged (still unread, subject/body intact)
    const bRow = db.prepare('SELECT is_read, subject, body_preview FROM emails WHERE id=?').get(emailB);
    ok('4. B stored email unchanged', bRow.is_read === 0 && bRow.subject === B_SECRET && bRow.body_preview === 'B secret body', `is_read=${bRow.is_read}`);

    // 5. Missing id and foreign id produce the SAME safe response
    const rMissing = await req('PATCH', 999999, tokenA, { is_read: true });
    ok('5a. missing id → 404', rMissing.status === 404);
    ok('5b. foreign id and missing id are indistinguishable', rMissing.status === r2.status && rMissing.raw === r2.raw, `missing=${rMissing.raw} foreign=${r2.raw}`);

    // 6. Owner status does not bypass ownership (A is is_owner=1; still 404 on B).
    ok('6. owner does NOT bypass ownership (A is_owner=1 blocked from B)', r2.status === 404);

    // Bonus: adjacent routes — GET/:id and DELETE/:id must be scoped too.
    const gForeign = await req('GET', emailB, tokenA);
    ok('7. GET /:id foreign → 404, no leak', gForeign.status === 404 && !gForeign.raw.includes(B_SECRET));
    const dForeign = await req('DELETE', emailB, tokenA);
    const bDeleted = db.prepare('SELECT is_deleted FROM emails WHERE id=?').get(emailB).is_deleted;
    ok('8. DELETE /:id foreign → 404 and B not soft-deleted', dForeign.status === 404 && (bDeleted === 0 || bDeleted === null));

    // Bonus: non-owner cross-account (B cannot read A) — symmetric proof.
    const r9 = await req('PATCH', emailA, tokenB, { is_read: true });
    ok('9. B (non-owner) PATCH A email → 404, no leak', r9.status === 404 && !r9.raw.includes(A_SECRET));

  } catch (err) {
    fail++; console.log('FAIL  harness error —', err.message);
  } finally {
    server.close();
    try { db.close(); } catch {}
    for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  }
});
