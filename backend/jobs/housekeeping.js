'use strict';
/**
 * Routine housekeeping — runs in-process on an unref'd timer (the backend is a
 * single Render instance; see utils/rateLimiter.js for the same assumption).
 * Nothing here runs on the request path.
 *
 * Expired sessions
 *   A row is deleted only when julianday(expires_at) is at least
 *   SESSION_GRACE_SECONDS in the past. lookupSession accepts a row only while
 *   julianday(expires_at) > julianday('now'), so a deleted row can never be one
 *   that would still authenticate — the cleanup cannot end an active session.
 *   julianday() compares absolute UTC instants (ISO 'Z' and legacy
 *   'YYYY-MM-DD HH:MM:SS' alike), so server time zone and DST do not matter;
 *   unparseable values are never deleted (and never authenticate).
 *   Each batch range-scans idx_sessions_expires (`expires_at < cutoff`, a
 *   superset of the expired rows for both stored formats) and is bounded by
 *   LIMIT, with a yield between batches — never a full-table scan per request.
 */

const db = require('../db');

// Expired rows are kept for a week so /auth/logout can still attribute and
// remove a device's push registration after its session expired.
const SESSION_GRACE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_BATCH         = 500;
const SESSION_MAX_BATCHES   = 20;            // ≤ 10,000 rows per run
const FIRST_RUN_DELAY_MS    = 60 * 1000;
const INTERVAL_MS           = 30 * 60 * 1000;

const purgeSessionsStmt = db.prepare(`
  DELETE FROM sessions WHERE token IN (
    SELECT token FROM sessions
    WHERE expires_at < @cutoffText
      AND julianday(expires_at) <= julianday('now', @grace)
    LIMIT @limit
  )
`);

const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * Delete expired session rows in bounded batches.
 * @returns {Promise<number>} rows removed
 */
async function purgeExpiredSessions({
  graceSeconds = SESSION_GRACE_SECONDS,
  batchSize    = SESSION_BATCH,
  maxBatches   = SESSION_MAX_BATCHES,
} = {}) {
  const grace = Math.max(0, Math.floor(graceSeconds));
  // Text cutoff only narrows the index range; the julianday() test decides.
  const cutoffText = new Date(Date.now() - grace * 1000).toISOString();
  let removed = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = purgeSessionsStmt.run({ cutoffText, grace: `-${grace} seconds`, limit: batchSize }).changes;
    removed += n;
    if (n < batchSize) break;
    await tick();
  }
  return removed;
}

// Other modules (e.g. the Gmail OAuth flow cleanup) register their own tasks.
const tasks = [{ name: 'expired sessions', run: purgeExpiredSessions }];
function registerHousekeeping(name, run) { tasks.push({ name, run }); }

let running = false;
let lastRun = null;                          // { at, removed: { [task]: n } } — counts only
async function runHousekeeping() {
  if (running) return;                      // never overlap runs
  running = true;
  const removed = {};
  try {
    for (const t of tasks) {
      try {
        const n = await t.run();
        removed[t.name] = n;
        if (n > 0) console.log(`[Housekeeping] ${t.name}: removed ${n}`);
      } catch (err) {
        removed[t.name] = 'failed';
        console.error(`[Housekeeping] ${t.name} failed: ${err?.code || err?.name || 'error'}`);
      }
    }
  } finally {
    lastRun = { at: new Date().toISOString(), removed };
    running = false;
  }
}
const getLastHousekeeping = () => lastRun;

let started = false;
function startHousekeeping() {
  if (started) return;
  started = true;
  setTimeout(() => { runHousekeeping(); }, FIRST_RUN_DELAY_MS).unref();
  setInterval(() => { runHousekeeping(); }, INTERVAL_MS).unref();
}

module.exports = {
  startHousekeeping, runHousekeeping, registerHousekeeping, purgeExpiredSessions, getLastHousekeeping,
  SESSION_GRACE_SECONDS,
};
