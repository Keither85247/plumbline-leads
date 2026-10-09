'use strict';
/**
 * Trusted-recording helper (DEF-2, Part C).
 *
 * Twilio credentials (Account SID + Auth Token) must NEVER be sent to a URL
 * that came from a webhook body or a database column without being proven to
 * point at Twilio's own recording API for THIS account. This module is the one
 * place that decides what a "safe" recording URL is; every download/proxy path
 * (voicemail processing, answered-call processing, and the authenticated
 * playback proxies) goes through it.
 *
 * Strategy, strongest first:
 *   1. If a Twilio RecordingSid is available, DERIVE the canonical media URL
 *      from the CONFIGURED account SID + that SID. The attacker-supplied URL is
 *      ignored entirely.
 *   2. Otherwise, STRICTLY validate a supplied URL: https only, exact host
 *      api.twilio.com, no userinfo, no odd port, exact Twilio recording path,
 *      and the Account SID embedded in the path must equal the configured one.
 *
 * Because the host must equal `api.twilio.com` EXACTLY, every other class of
 * target is rejected for free: http, lookalike domains
 * (api.twilio.com.attacker.example), userinfo tricks (api.twilio.com@evil),
 * IP literals, localhost, private / link-local ranges, and the cloud metadata
 * endpoint (169.254.169.254) — none of them equal api.twilio.com.
 */

const TWILIO_HOST     = 'api.twilio.com';
const ACCOUNT_SID_RE  = /^AC[0-9a-f]{32}$/i;
const RECORDING_SID_RE = /^RE[0-9a-f]{32}$/i;
// Twilio recording resource path: /2010-04-01/Accounts/AC.../Recordings/RE...(.ext)?
const RECORDING_PATH_RE = /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Recordings\/(RE[0-9a-f]{32})(\.[A-Za-z0-9]+)?$/;

function configuredAccountSid() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  return sid && ACCOUNT_SID_RE.test(sid) ? sid : null;
}

/** Build the canonical .mp3 media URL from a trusted RecordingSid, or null. */
function canonicalRecordingUrl(recordingSid) {
  const accountSid = configuredAccountSid();
  if (!accountSid) return null;
  if (!recordingSid || !RECORDING_SID_RE.test(recordingSid)) return null;
  return `https://${TWILIO_HOST}/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
}

/**
 * Validate an arbitrary recording URL. Returns a normalized .mp3 URL on the
 * configured account, or throws Error with a short, non-sensitive reason.
 */
function assertSafeRecordingUrl(rawUrl) {
  const accountSid = configuredAccountSid();
  if (!accountSid) throw new Error('twilio account not configured');
  if (typeof rawUrl !== 'string' || !rawUrl) throw new Error('missing url');

  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('malformed url'); }

  if (u.protocol !== 'https:')               throw new Error('non-https url');
  if (u.username || u.password)              throw new Error('url contains credentials');
  if (u.hostname !== TWILIO_HOST)           throw new Error('host not allowed');       // exact match only
  if (u.port && u.port !== '443')           throw new Error('non-standard port');

  const m = u.pathname.match(RECORDING_PATH_RE);
  if (!m)                                    throw new Error('unexpected path');
  if (m[1].toLowerCase() !== accountSid.toLowerCase()) throw new Error('account sid mismatch');

  // Normalize: drop any query/hash, force .mp3 media form.
  const base = u.pathname.replace(/\.[A-Za-z0-9]+$/, '');
  return `https://${TWILIO_HOST}${base}.mp3`;
}

/**
 * Resolve a credential-eligible recording URL. Prefers a trusted RecordingSid,
 * falls back to strict validation of a supplied URL. Throws if neither yields a
 * safe destination — callers MUST NOT attach credentials on throw.
 */
function resolveSafeRecordingUrl({ recordingSid, recordingUrl } = {}) {
  const derived = canonicalRecordingUrl(recordingSid);
  if (derived) return derived;
  if (recordingUrl) return assertSafeRecordingUrl(recordingUrl);
  throw new Error('no usable recording reference');
}

// ── Inbound MMS media (MediaUrlN) ─────────────────────────────────────────────
// https://api.twilio.com/2010-04-01/Accounts/AC…/Messages/MM…/Media/ME… (no extension)
const MEDIA_PATH_RE = /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Messages\/((?:MM|SM)[0-9a-f]{32})\/Media\/(ME[0-9a-f]{32})$/;

/**
 * Validate a stored inbound MMS media URL. Returns the canonical URL on the
 * configured account, or throws Error with a short, non-sensitive reason.
 * Same exact-host / exact-path discipline as assertSafeRecordingUrl.
 */
function assertSafeTwilioMediaUrl(rawUrl) {
  const accountSid = configuredAccountSid();
  if (!accountSid) throw new Error('twilio account not configured');
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > 2048) throw new Error('missing url');
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('malformed url'); }
  if (u.protocol !== 'https:')               throw new Error('non-https url');
  if (u.username || u.password)              throw new Error('url contains credentials');
  if (u.hostname !== TWILIO_HOST)           throw new Error('host not allowed');
  if (u.port && u.port !== '443')           throw new Error('non-standard port');
  const m = u.pathname.match(MEDIA_PATH_RE);
  if (!m)                                    throw new Error('unexpected path');
  if (m[1].toLowerCase() !== accountSid.toLowerCase()) throw new Error('account sid mismatch');
  return `https://${TWILIO_HOST}${u.pathname}`;
}

/** First hop: only Twilio's own API host. */
function isTwilioApiUrl(u) {
  return u.hostname === TWILIO_HOST;
}

/**
 * Where Twilio redirects media requests (fetched WITHOUT credentials):
 * secured media → mms.twiliocdn.com; unsecured media →
 * s3-external-1.amazonaws.com/media.twiliocdn.com/…  (Twilio help center,
 * "How to Protect Media Access With HTTP Basic Authentication").
 */
function isTwilioMediaRedirect(u) {
  const h = u.hostname;
  if (h === 'mms.twiliocdn.com' || h === 'media.twiliocdn.com') return true;
  return h === 's3-external-1.amazonaws.com' && u.pathname.startsWith('/media.twiliocdn.com/');
}

module.exports = {
  TWILIO_HOST,
  canonicalRecordingUrl,
  assertSafeRecordingUrl,
  resolveSafeRecordingUrl,
  assertSafeTwilioMediaUrl,
  isTwilioApiUrl,
  isTwilioMediaRedirect,
};
