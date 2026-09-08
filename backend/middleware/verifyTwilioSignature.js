'use strict';
/**
 * Twilio webhook signature validation (DEF-2, Part B).
 *
 * Uses Twilio's official `twilio.validateRequest` — no hand-rolled crypto.
 * Must run AFTER the body parser (express.urlencoded) so the form params are
 * available, and BEFORE any side effect (DB write, OpenAI, recording download,
 * push, or Twilio REST call).
 *
 * Public URL reconstruction:
 *   Twilio signs the exact URL it was configured to call. Every webhook URL in
 *   this app is built from the canonical `TWILIO_BASE_URL` (e.g.
 *   https://<service>.onrender.com), so we reconstruct the signed URL as
 *   `TWILIO_BASE_URL + req.originalUrl` — where originalUrl carries the mount
 *   path AND any query string (e.g. /api/twilio/voicemail?user_id=5).
 *
 *   We deliberately do NOT derive the URL from req.protocol / req.host: behind
 *   Render's reverse proxy those are the INTERNAL http origin and would never
 *   match the https URL Twilio signed. Using the configured base URL means no
 *   `app.set('trust proxy')` is required for validation to be correct.
 *
 * Fail-closed: if the Auth Token or base URL is not configured, requests are
 * rejected (403) rather than allowed through.
 *
 * Dev-only bypass: `TWILIO_SKIP_WEBHOOK_VALIDATION=true` skips validation, but
 * ONLY when NODE_ENV !== 'production'. It can never take effect in production.
 */

const twilio = require('twilio');
const log = require('../logger').for('TwilioSig');

function bypassActive() {
  return process.env.NODE_ENV !== 'production'
      && process.env.TWILIO_SKIP_WEBHOOK_VALIDATION === 'true';
}

module.exports = function verifyTwilioSignature(req, res, next) {
  if (bypassActive()) {
    log.warn('Twilio signature validation BYPASSED (development only)', { path: req.path });
    return next();
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl   = (process.env.TWILIO_BASE_URL || '').replace(/\/+$/, '');

  // Fail closed — never process an unverifiable webhook.
  if (!authToken || !baseUrl) {
    log.error('Cannot validate Twilio signature — missing configuration', {
      hasAuthToken: !!authToken, hasBaseUrl: !!baseUrl, path: req.path,
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const signature = req.header('X-Twilio-Signature');
  if (!signature) {
    log.warn('Rejected Twilio webhook — missing signature', { path: req.path });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Exact public URL Twilio signed (path + query), from the canonical base URL.
  const url = baseUrl + req.originalUrl;
  const params = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : {};

  let valid = false;
  try {
    valid = twilio.validateRequest(authToken, signature, url, params);
  } catch (err) {
    // Never log the signature or auth token.
    log.error('Signature validation error', { path: req.path, err: err.message });
    valid = false;
  }

  if (!valid) {
    log.warn('Rejected Twilio webhook — invalid signature', { path: req.path });
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
};
