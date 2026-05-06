'use strict';
/**
 * SMS abuse guardrails middleware.
 *
 * Must be applied AFTER multer on the /api/messages/send route so that
 * req.body (from FormData) is already parsed before these checks run.
 *
 * Skips all rate-limit checks for is_owner accounts so existing owner/admin
 * behaviour is completely unaffected.
 *
 * All limits are configurable via Render environment variables — change them
 * without redeploying by setting the env var and restarting the service.
 *
 * Configurable limits (defaults shown):
 *   SMS_DAILY_LIMIT             = 50   messages per UTC day
 *   SMS_BURST_WINDOW_SECS       = 60   seconds window for burst check
 *   SMS_BURST_LIMIT             = 5    messages within that window
 *   SMS_UNIQ_RECIP_MINS         = 5    minutes window for unique-recipient check
 *   SMS_UNIQ_RECIP_LIMIT        = 10   distinct numbers within that window
 *   SMS_IDENTICAL_WINDOW_MINS   = 60   minutes window for identical-body check
 *   SMS_IDENTICAL_RECIP_LIMIT   = 3    distinct recipients with same body in that window
 */

const db  = require('../db');
const log = require('../logger').for('SmsGuards');

// ── Configurable limits ───────────────────────────────────────────────────────
const DAILY_LIMIT         = parseInt(process.env.SMS_DAILY_LIMIT           || '50',  10);
const BURST_WINDOW_SECS   = parseInt(process.env.SMS_BURST_WINDOW_SECS     || '60',  10);
const BURST_LIMIT         = parseInt(process.env.SMS_BURST_LIMIT           || '5',   10);
const UNIQ_RECIP_MINS     = parseInt(process.env.SMS_UNIQ_RECIP_MINS       || '5',   10);
const UNIQ_RECIP_LIMIT    = parseInt(process.env.SMS_UNIQ_RECIP_LIMIT      || '10',  10);
const IDENTICAL_WINDOW_MINS    = parseInt(process.env.SMS_IDENTICAL_WINDOW_MINS   || '60', 10);
const IDENTICAL_RECIP_LIMIT    = parseInt(process.env.SMS_IDENTICAL_RECIP_LIMIT   || '3',  10);

// US + Canada (NANP): +1 followed by exactly 10 digits.
// Blocks all other international numbers for tester accounts.
function isNanpNumber(e164) {
  return /^\+1\d{10}$/.test(e164 || '');
}

// Normalise to E.164 — mirrors the same logic in messages.js so the check
// operates on the same format that will ultimately be sent to Twilio.
function toE164(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10)                        return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1')   return `+${digits}`;
  return raw.trim();
}

module.exports = function smsGuards(req, res, next) {
  const userId = req.userId;
  const rawTo  = req.body?.to || '';
  const body   = (req.body?.body || '').trim();

  // ── 1. User-level suspension ───────────────────────────────────────────────
  const user = db.prepare(
    'SELECT is_owner, is_suspended, email FROM users WHERE id = ?'
  ).get(userId);

  if (!user) return res.status(401).json({ error: 'User not found' });

  if (user.is_suspended) {
    log.warn('SMS blocked — user suspended', { userId, email: user.email, to: rawTo });
    return res.status(403).json({
      error: 'Your account has been suspended. Please contact your administrator.',
    });
  }

  // ── Owners bypass every rate-limit and geo check ───────────────────────────
  if (user.is_owner) return next();

  // ── 2. Number-level suspension ─────────────────────────────────────────────
  const numRow = db.prepare(
    'SELECT is_suspended, phone_number FROM phone_numbers WHERE assigned_user_id = ? LIMIT 1'
  ).get(userId);

  if (numRow?.is_suspended) {
    log.warn('SMS blocked — number suspended', {
      userId, email: user.email, number: numRow.phone_number, to: rawTo,
    });
    return res.status(403).json({
      error: 'Messaging temporarily restricted. Contact your administrator.',
    });
  }

  // ── 3. International destination block ────────────────────────────────────
  const dest = toE164(rawTo);
  if (!isNanpNumber(dest)) {
    log.warn('SMS blocked — non-NANP destination', { userId, email: user.email, to: rawTo, e164: dest });
    return res.status(400).json({
      error: 'International messaging is not enabled for tester accounts. US and Canada numbers only.',
    });
  }

  // ── 4. Daily send limit ────────────────────────────────────────────────────
  const todayCount = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE user_id = ? AND direction = 'outbound'
      AND created_at >= date('now')
  `).get(userId)?.n ?? 0;

  if (todayCount >= DAILY_LIMIT) {
    log.warn('SMS blocked — daily limit reached', {
      userId, email: user.email, todayCount, limit: DAILY_LIMIT,
    });
    return res.status(429).json({
      error: `Daily messaging limit reached (${DAILY_LIMIT} messages/day). Resets at midnight UTC.`,
    });
  }

  // ── 5. Burst limit ─────────────────────────────────────────────────────────
  const burstCount = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE user_id = ? AND direction = 'outbound'
      AND created_at >= datetime('now', '-' || ? || ' seconds')
  `).get(userId, BURST_WINDOW_SECS)?.n ?? 0;

  if (burstCount >= BURST_LIMIT) {
    log.warn('SMS blocked — burst limit', {
      userId, email: user.email, burstCount, window: `${BURST_WINDOW_SECS}s`, limit: BURST_LIMIT,
    });
    return res.status(429).json({
      error: 'Messaging temporarily restricted. Please wait a moment before sending again.',
    });
  }

  // ── 6. Unique recipient abuse ──────────────────────────────────────────────
  const uniqRecip = db.prepare(`
    SELECT COUNT(DISTINCT phone) AS n FROM messages
    WHERE user_id = ? AND direction = 'outbound'
      AND created_at >= datetime('now', '-' || ? || ' minutes')
  `).get(userId, UNIQ_RECIP_MINS)?.n ?? 0;

  if (uniqRecip >= UNIQ_RECIP_LIMIT) {
    log.warn('SMS blocked — too many unique recipients', {
      userId, email: user.email, uniqRecip, window: `${UNIQ_RECIP_MINS}m`, limit: UNIQ_RECIP_LIMIT,
    });
    return res.status(429).json({
      error: 'Messaging temporarily restricted. Too many different contacts in a short period.',
    });
  }

  // ── 7. Identical body to multiple recipients ───────────────────────────────
  // Catches copy-paste mass-blasts: same message text sent to N+ distinct
  // phones within the window. Only checked when a non-empty body is present.
  if (body.length > 0) {
    const identicalCount = db.prepare(`
      SELECT COUNT(DISTINCT phone) AS n FROM messages
      WHERE user_id = ? AND direction = 'outbound' AND body = ?
        AND created_at >= datetime('now', '-' || ? || ' minutes')
    `).get(userId, body, IDENTICAL_WINDOW_MINS)?.n ?? 0;

    if (identicalCount >= IDENTICAL_RECIP_LIMIT) {
      log.warn('SMS blocked — identical body to too many recipients', {
        userId, email: user.email,
        identicalCount, window: `${IDENTICAL_WINDOW_MINS}m`, limit: IDENTICAL_RECIP_LIMIT,
      });
      return res.status(429).json({
        error: 'Messaging temporarily restricted. Repeated identical messages detected.',
      });
    }
  }

  // All checks passed
  next();
};
