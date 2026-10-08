'use strict';
/**
 * Revoke a Google OAuth token without putting it in a URL.
 *
 * google-auth-library's revokeToken() sends POST /revoke?token=<token>, which
 * places a live token in the request URL (and therefore in HTTP client
 * breadcrumbs, tracing spans and network error messages). This helper uses the
 * RFC 7009 form instead: the token travels only in the request body. Errors are
 * swallowed; callers log fixed codes only.
 *
 * Revoking cancels the app's ENTIRE grant for that Google user, so callers must
 * first check addressInUse(): never revoke while another Plumbline account is
 * connected to the same Google address, or a live (parked) connect attempt holds
 * tokens for it.
 */

const https = require('https');
const db    = require('../db');

const REVOKE_HOST = 'oauth2.googleapis.com';

/** @returns {Promise<boolean>} true when Google accepted the revocation. */
function revokeGoogleToken(token) {
  if (typeof token !== 'string' || !token || token.length > 4096) return Promise.resolve(false);
  const body = new URLSearchParams({ token }).toString();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.request({
        host: REVOKE_HOST, path: '/revoke', method: 'POST', timeout: 10_000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); finish(res.statusCode === 200); });
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.on('error', () => finish(false));
      req.end(body);
    } catch {
      finish(false);
    }
  });
}

/**
 * Is this Google address still needed by anything else?
 * @param {string} email
 * @param {{ exceptUserId?: number, exceptFlowId?: number }} [opts]
 */
function addressInUse(email, { exceptUserId = null, exceptFlowId = null } = {}) {
  if (typeof email !== 'string' || !email) return true;      // unknown → be safe, don't revoke
  const connected = db.prepare(
    'SELECT 1 FROM gmail_tokens WHERE LOWER(email) = LOWER(?) AND (? IS NULL OR user_id IS NOT ?) LIMIT 1'
  ).get(email, exceptUserId, exceptUserId);
  if (connected) return true;
  const parked = db.prepare(`
    SELECT 1 FROM gmail_oauth_flows
    WHERE status = 'parked' AND LOWER(google_email) = LOWER(?) AND (? IS NULL OR id <> ?)
      AND julianday(handle_expires) > julianday('now')
    LIMIT 1
  `).get(email, exceptFlowId, exceptFlowId);
  return !!parked;
}

module.exports = { revokeGoogleToken, addressInUse };
