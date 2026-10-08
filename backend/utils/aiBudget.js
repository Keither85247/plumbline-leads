'use strict';
/**
 * Paid-AI usage budget for user-initiated transcription / transcript analysis
 * (/api/transcribe and manual POST /api/leads both run createLeadFromTranscript,
 * which calls OpenAI). Per account, plus a global ceiling across all accounts.
 * In-memory; see utils/rateLimiter.js for restart and scaling behaviour.
 */

const { createLimiter } = require('./rateLimiter');

const HOUR = 60 * 60 * 1000;
const transcribeLimits = {
  accountHour: createLimiter({ name: 'transcribe-account-hour', windowMs: HOUR,      max: 10 }),
  accountDay:  createLimiter({ name: 'transcribe-account-day',  windowMs: 24 * HOUR, max: 40 }),
  globalDay:   createLimiter({ name: 'transcribe-global-day',   windowMs: 24 * HOUR, max: 200 }),
};
const TRANSCRIBE_THROTTLED = { error: 'Transcription limit reached. Please try again later.' };

/** Express middleware (after requireAuth). Mount BEFORE any upload parsing. */
function transcribeRateLimit(req, res, next) {
  const key = String(req.userId);
  const wait = transcribeLimits.accountHour.check(key) || transcribeLimits.accountDay.check(key)
    || transcribeLimits.globalDay.check('all');
  if (wait) {
    console.warn(`[AI budget] Throttled user ${req.userId}`);
    return res.status(429).set('Retry-After', String(wait)).json(TRANSCRIBE_THROTTLED);
  }
  transcribeLimits.accountHour.hit(key);
  transcribeLimits.accountDay.hit(key);
  transcribeLimits.globalDay.hit('all');
  next();
}

module.exports = { transcribeLimits, transcribeRateLimit };
