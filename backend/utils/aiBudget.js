'use strict';
/**
 * Paid-AI usage budget for user-initiated AI requests.
 *
 *   Transcription / transcript analysis — /api/transcribe and manual
 *   POST /api/leads both run createLeadFromTranscript (OpenAI). They share
 *   one per-account budget, so neither route can be used to bypass the other.
 *   Translation — /api/translate (OpenAI) has its own per-account budget.
 *
 * Every request of either kind also counts toward ONE global daily ceiling
 * across all accounts and all paid-AI features (aiGlobalDay), and transcription
 * keeps its tighter global ceiling (Whisper + GPT per request).
 *
 * Limits are checked before any AI call. Responses are generic and no
 * submitted content is logged. In-memory: on the single Render instance the
 * limits are effectively global; a restart/deploy resets them; N instances
 * would multiply them by N (see utils/rateLimiter.js).
 */

const { createLimiter } = require('./rateLimiter');

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// One ceiling for every paid-AI request (transcription + translation).
const aiGlobalDay = createLimiter({ name: 'ai-global-day', windowMs: DAY, max: 1000 });

const transcribeLimits = {
  accountHour: createLimiter({ name: 'transcribe-account-hour', windowMs: HOUR, max: 10 }),
  accountDay:  createLimiter({ name: 'transcribe-account-day',  windowMs: DAY,  max: 40 }),
  globalDay:   createLimiter({ name: 'transcribe-global-day',   windowMs: DAY,  max: 200 }),
  aiGlobalDay,
};

const translateLimits = {
  accountHour: createLimiter({ name: 'translate-account-hour', windowMs: HOUR, max: 30 }),
  accountDay:  createLimiter({ name: 'translate-account-day',  windowMs: DAY,  max: 150 }),
  aiGlobalDay,
};

function budgetMiddleware(kind, limits, body) {
  return function aiBudget(req, res, next) {
    const key  = String(req.userId);
    const wait = limits.accountHour.check(key) || limits.accountDay.check(key)
      || (limits.globalDay ? limits.globalDay.check('all') : 0)
      || aiGlobalDay.check('all');
    if (wait) {
      console.warn(`[AI budget] ${kind} throttled for user ${req.userId}`);
      return res.status(429).set('Retry-After', String(wait)).json(body);
    }
    limits.accountHour.hit(key);
    limits.accountDay.hit(key);
    if (limits.globalDay) limits.globalDay.hit('all');
    aiGlobalDay.hit('all');
    next();
  };
}

/** Express middleware (after requireAuth). Mount BEFORE any upload parsing. */
const transcribeRateLimit = budgetMiddleware('transcription', transcribeLimits,
  Object.freeze({ error: 'Transcription limit reached. Please try again later.' }));

/** Express middleware (after requireAuth and input validation). */
const translateRateLimit = budgetMiddleware('translation', translateLimits,
  Object.freeze({ error: 'Translation limit reached. Please try again later.' }));

module.exports = {
  transcribeLimits, transcribeRateLimit,
  translateLimits, translateRateLimit,
  aiGlobalDay,
};
