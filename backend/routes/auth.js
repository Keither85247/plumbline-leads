'use strict';
const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcrypt');
const crypto       = require('crypto');
const { google }   = require('googleapis');
const db           = require('../db');
const requireAuth  = require('../middleware/requireAuth');
const { createBaseClient, syncRecentEmails } = require('../services/gmailService');
const { revokeGoogleToken, addressInUse } = require('../utils/googleRevoke');   // disconnect only
const { sessionCandidates, resolveSession, revokeUserSessions, ACCOUNT_DISABLED_ERROR } = require('../utils/session');
const { isDisabledRow, isAccountActive } = require('../utils/accountStatus');
const { frontendOrigins, originAllowed, requireAppRequest } = require('../utils/appRequest');
const { createLimiter, createRecentSet } = require('../utils/rateLimiter');
const { clientIpKey, wideIpKey } = require('../utils/clientIp');
const { ENDPOINT_MAX, FCM_TOKEN_MAX, isDeletableIdentifier } = require('../utils/pushValidation');

// ── Login rate limits (in-memory; see utils/rateLimiter.js for restart/scaling) ─
// Keyed so one attacker cannot lock out every user (there is deliberately no
// global cap): attempts/failures are counted per IP (IPv6 per /64, plus a wider
// /48 tier against address rotation) and per email+IP. A per-email cap across
// IPs limits distributed guessing against one account; IPs that have recently
// signed in to that account are exempt, so its owner keeps access during an attack.
const MIN = 60 * 1000;
const loginLimits = {
  ipAttempts:   createLimiter({ name: 'login-ip',            windowMs: 15 * MIN, max: 50 }),
  ipFailures:   createLimiter({ name: 'login-ip-fail',       windowMs: 15 * MIN, max: 20 }),
  wideAttempts: createLimiter({ name: 'login-ip48',          windowMs: 15 * MIN, max: 250 }),
  wideFailures: createLimiter({ name: 'login-ip48-fail',     windowMs: 15 * MIN, max: 100 }),
  emailIpFail:  createLimiter({ name: 'login-email-ip-fail', windowMs: 15 * MIN, max: 5 }),
  emailFail:    createLimiter({ name: 'login-email-fail',    windowMs: 60 * MIN, max: 20 }),
};
const knownLoginIps = createRecentSet({ ttlMs: 30 * 24 * 60 * MIN });
const LOGIN_THROTTLED = { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' };
const emailKey = (email) => crypto.createHash('sha256').update(email).digest('base64url').slice(0, 22);
// Unknown emails still run one bcrypt.compare so response timing does not
// reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// ── Access status helper ──────────────────────────────────────────────────────
// Derives the effective access status for a user row.
// Owners bypass paywall unconditionally. Everyone else uses the stored column.
function effectiveAccessStatus(user) {
  if (!user) return 'unknown';
  if (user.is_owner) return 'owner';
  return user.access_status || 'unknown';
}

// ── Session helpers ───────────────────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Returns the Set-Cookie options appropriate for the current environment.
 *
 * Production (cross-origin, Vercel frontend → Render backend):
 *   SameSite=None; Secure — required so the browser sends the cookie on
 *   credentialed cross-origin fetch() requests (credentials:'include').
 *   Without None, SameSite=Lax silently drops the cookie on every API call
 *   and the backend always sees an unauthenticated request.
 *
 *   Safari note: ITP can block SameSite=None cookies from third-party domains.
 *   The fix is to route API calls through a same-origin Vercel proxy (rewrites
 *   in vercel.json) AND remove VITE_BACKEND_URL from Vercel env vars so the
 *   frontend uses relative paths. Once that's confirmed working, SameSite can
 *   be changed to Lax since all requests will be same-origin.
 *
 * Development (Vite proxy, same-origin):
 *   SameSite=Lax — works fine without Secure flag.
 */
function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge:   SESSION_TTL_MS,
    path:     '/',
  };
}

function clearOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return { path: '/', secure: isProd, sameSite: isProd ? 'none' : 'lax' };
}

// ── POST /auth/login ──────────────────────────────────────────────────────────
// Verifies email + bcrypt password, creates a session, sets httpOnly cookie.

router.post('/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  const origin = req.headers.origin || '(no origin)';

  // Strict types first: a non-string email used to throw inside this async
  // handler (crashing the process and resetting in-memory rate limits).
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password
      || email.length > 254 || password.length > 1024) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const ipKey   = clientIpKey(req);
  const wideKey = wideIpKey(ipKey);
  const eKey    = emailKey(normalizedEmail);
  const eipKey  = ipKey ? `${eKey}|${ipKey}` : null;
  const knownIp = knownLoginIps.has(eipKey);

  // Rate limits are checked BEFORE the user lookup, so the response never
  // depends on whether the email exists.
  const wait = loginLimits.ipAttempts.check(ipKey) || loginLimits.ipFailures.check(ipKey)
    || loginLimits.wideAttempts.check(wideKey) || loginLimits.wideFailures.check(wideKey)
    || loginLimits.emailIpFail.check(eipKey)
    || (knownIp ? 0 : loginLimits.emailFail.check(eKey));
  if (wait) {
    console.warn('[Auth] Login throttled');
    return res.status(429).set('Retry-After', String(wait)).json(LOGIN_THROTTLED);
  }
  loginLimits.ipAttempts.hit(ipKey);
  loginLimits.wideAttempts.hit(wideKey);
  const recordFailure = () => {
    loginLimits.ipFailures.hit(ipKey);
    loginLimits.wideFailures.hit(wideKey);
    loginLimits.emailIpFail.hit(eipKey);
    loginLimits.emailFail.hit(eKey);
  };

  const user = db.prepare(
    'SELECT * FROM users WHERE LOWER(email) = ?'
  ).get(normalizedEmail);

  // The client always gets the same generic message (no email enumeration).
  // Logs record the reason without the submitted email address.
  if (!user || !user.password_hash) {
    try { await bcrypt.compare(password, DUMMY_HASH); } catch { /* timing only */ }
    recordFailure();
    console.warn(`[Auth] Login failed — ${user ? `user id=${user.id} has no password set` : 'unknown account'}`);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  let match = false;
  try {
    match = await bcrypt.compare(password, user.password_hash);
  } catch (bcryptErr) {
    console.error(`[Auth] bcrypt.compare threw for user id=${user.id}:`, bcryptErr.message);
    return res.status(500).json({ error: 'Server error during authentication' });
  }

  if (!match) {
    recordFailure();
    console.warn(`[Auth] Login failed — password mismatch for user id=${user.id}`);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Correct password: clear this account's failure counters and remember this
  // IP as a known sign-in location for the account.
  loginLimits.emailIpFail.reset(eipKey);
  loginLimits.emailFail.reset(eKey);
  knownLoginIps.add(eipKey);

  // Suspended or blocked accounts cannot sign in. Checked only after the
  // password is verified, so it reveals nothing to someone without the password.
  if (isDisabledRow(user)) {
    console.warn(`[Auth] Login refused — user id=${user.id} is not active`);
    return res.status(403).json(ACCOUNT_DISABLED_ERROR);
  }

  // Create session
  let token;
  try {
    token           = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(token, user.id, expiresAt);
  } catch (sessionErr) {
    console.error(`[Auth] Session save failed for user id=${user.id}:`, sessionErr.message);
    return res.status(500).json({ error: 'Server error creating session' });
  }

  const opts = cookieOptions();
  res.cookie('plumbline_session', token, opts);

  // Log cookie attributes — if SameSite=lax in production, NODE_ENV is not set correctly.
  console.log(`[Auth] ✓ Login success: user id=${user.id} is_owner=${user.is_owner} — cookie SameSite=${opts.sameSite} Secure=${opts.secure} origin=${origin}`);

  // Include assigned phone number so the frontend doesn't need a separate /api/numbers/mine call.
  const phoneRow = user.is_owner ? null : db.prepare(
    'SELECT id, phone_number, friendly_name, twilio_sid FROM phone_numbers WHERE assigned_user_id = ? LIMIT 1'
  ).get(user.id);

  console.log(`[Auth] assignedNumber for user ${user.id}: ${phoneRow ? phoneRow.phone_number : 'none'}`);

  // Include token in response body for Safari ITP (blocked cross-origin cookies).
  return res.json({
    id:            user.id,
    email:         user.email,
    display_name:  user.display_name,
    is_owner:      user.is_owner,
    access_status: effectiveAccessStatus(user),
    token,
    assignedNumber: phoneRow || null,
  });
});

// ── POST /auth/register ───────────────────────────────────────────────────────
// Self-service account creation. Only enabled when ALLOW_PUBLIC_SIGNUP=true.
// Always creates non-owner (tester) accounts — owner accounts cannot be created
// through this endpoint regardless of what is in the request body.

router.post('/register', express.json(), async (req, res) => {
  if (process.env.ALLOW_PUBLIC_SIGNUP !== 'true') {
    return res.status(403).json({ error: 'Public sign-up is not enabled' });
  }

  const { email, password, display_name, business_name } = req.body || {};
  const origin = req.headers.origin || '(no origin)';

  if (typeof email !== 'string' || typeof password !== 'string' || typeof display_name !== 'string'
      || !email.trim() || !password || !display_name.trim()
      || (business_name != null && typeof business_name !== 'string')
      || email.length > 254 || password.length > 1024) {
    return res.status(400).json({ error: 'email, password, and display_name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  console.log(`[Auth] Register attempt: "${normalizedEmail}" from ${origin}`);

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(normalizedEmail);
  if (existing) {
    console.warn(`[Auth] Register failed — email already exists: "${normalizedEmail}"`);
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  let passwordHash;
  try {
    passwordHash = await bcrypt.hash(password, 12);
  } catch (err) {
    console.error('[Auth] bcrypt.hash failed during register:', err.message);
    return res.status(500).json({ error: 'Server error during registration' });
  }

  const apiKey = crypto.randomBytes(24).toString('hex');
  let newUserId;
  try {
    const result = db.prepare(
      'INSERT INTO users (email, display_name, business_name, password_hash, api_key, is_owner) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(normalizedEmail, display_name.trim(), (business_name || '').trim(), passwordHash, apiKey);
    newUserId = result.lastInsertRowid;
  } catch (err) {
    console.error('[Auth] User insert failed during register:', err.message);
    return res.status(500).json({ error: 'Server error creating account' });
  }

  // Start a session immediately so the user is logged in after signup
  let token;
  try {
    token           = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(token, newUserId, expiresAt);
  } catch (err) {
    console.error(`[Auth] Session save failed after register for user id=${newUserId}:`, err.message);
    return res.status(500).json({ error: 'Account created but could not start session' });
  }

  const opts = cookieOptions();
  res.cookie('plumbline_session', token, opts);

  console.log(`[Auth] ✓ Register success: user id=${newUserId} (${normalizedEmail}) — SameSite=${opts.sameSite} Secure=${opts.secure}`);

  // New accounts never have an assigned phone number yet
  return res.status(201).json({
    id:            newUserId,
    email:         normalizedEmail,
    display_name:  display_name.trim(),
    is_owner:      0,
    access_status: 'unknown',
    token,
    assignedNumber: null,
  });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
// Deletes the session row and clears the cookie.

router.post('/logout', (req, res) => {
  const { pushEndpoint, fcmToken } = req.body || {};
  // End every session credential this request presents (cookie and Bearer).
  for (const { token } of sessionCandidates(req)) {
    if (token.length > 256) continue;
    // Remove THIS device's push registration so notifications stop after
    // logout. Scoped to the session's own account; other devices are kept.
    // The row is found even after it expired (housekeeping keeps expired rows
    // for a 7-day grace), so cleanup still works for an expired session.
    // Identifiers are only type/length-checked here so rows stored before
    // validation existed can still be removed; invalid ones are skipped.
    const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
    if (session?.user_id) {
      if (isDeletableIdentifier(pushEndpoint, ENDPOINT_MAX)) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
          .run(pushEndpoint, session.user_id);
      }
      if (isDeletableIdentifier(fcmToken, FCM_TOKEN_MAX)) {
        db.prepare('DELETE FROM fcm_subscriptions WHERE fcm_token = ? AND user_id = ?')
          .run(fcmToken, session.user_id);
      }
    }
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.clearCookie('plumbline_session', clearOptions());
  console.log('[Auth] Logout');
  return res.json({ ok: true });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
// Returns the authenticated user's profile, or 401 if not logged in.
// Called by the frontend on mount to restore session state without a full login.

router.get('/me', (req, res) => {
  // Cookie and Bearer (Safari ITP); absolute-UTC expiry (see utils/session.js).
  const r = resolveSession(req);
  if (r.status === 'none') return res.status(401).json({ error: 'Not authenticated' });
  if (r.status !== 'ok') {
    res.clearCookie('plumbline_session', clearOptions());
    return res.status(401).json({ error: 'Session expired' });
  }
  if (r.staleCookie) res.clearCookie('plumbline_session', clearOptions());
  const session = r.session;
  if (session.disabled) {
    revokeUserSessions(session.userId);
    res.clearCookie('plumbline_session', clearOptions());
    return res.status(401).json(ACCOUNT_DISABLED_ERROR);
  }

  const row = db.prepare(
    'SELECT id, email, display_name, is_owner, access_status FROM users WHERE id = ?'
  ).get(session.userId);
  if (!row) {
    res.clearCookie('plumbline_session', clearOptions());
    return res.status(401).json({ error: 'Session expired' });
  }

  // Include assigned phone number so the frontend doesn't need a separate /api/numbers/mine call.
  const phoneRow = row.is_owner ? null : db.prepare(
    'SELECT id, phone_number, friendly_name, twilio_sid FROM phone_numbers WHERE assigned_user_id = ? LIMIT 1'
  ).get(row.id);

  return res.json({
    ...row,
    access_status:  effectiveAccessStatus(row),
    assignedNumber: phoneRow || null,
  });
});

// ── POST /auth/tester-bypass ──────────────────────────────────────────────────
// Marks the authenticated user as a beta tester, granting paywall access.
// Gated by ENABLE_TESTER_BYPASS=true env var on the backend.
// Cannot be used to elevate to owner/admin.

router.post('/tester-bypass', requireAuth, (req, res) => {
  if (process.env.ENABLE_TESTER_BYPASS !== 'true') {
    return res.status(403).json({ error: 'Tester bypass is not currently enabled' });
  }

  const user = db.prepare('SELECT id, is_owner, is_suspended, access_status FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Owners already have full access; no-op but succeed gracefully
  if (user.is_owner) {
    return res.json({ ok: true, access_status: 'owner' });
  }
  // Never lift a block (requireAuth already refuses blocked accounts; this is
  // defence in depth).
  if (isDisabledRow(user)) {
    return res.status(403).json(ACCOUNT_DISABLED_ERROR);
  }

  db.prepare("UPDATE users SET access_status = 'tester' WHERE id = ?").run(req.userId);
  console.log(`[Auth] Tester bypass activated for user ${req.userId}`);
  return res.json({ ok: true, access_status: 'tester' });
});

// ── Gmail OAuth ───────────────────────────────────────────────────────────────
// Connecting Gmail is a four-step flow that works in desktop browsers, Safari
// (ITP) and the Android app (whose WebView hands other-origin navigations to the
// external browser), without ever putting a session token in a URL:
//
//   1. POST /auth/google/start      — signed-in app (cookie or Bearer; JSON +
//      allowed Origin, so it cannot be triggered cross-site). Creates a flow row
//      bound to the account and returns a launch URL holding a single-use,
//      2-minute LAUNCH TICKET (not a session credential).
//   2. GET  /auth/google/launch?t=  — top-level navigation in the browser that
//      will talk to Google. Consumes the ticket, mints the OAuth state and a
//      browser NONCE (httpOnly SameSite=Lax cookie, path /auth/google), and
//      redirects to Google.
//   3. GET  /auth/google/callback   — consumes the state once, requires the same
//      browser's nonce, exchanges the code, verifies scopes and PARKS the tokens
//      on the flow (attached to no account yet). Redirects to the app with a
//      single-use, 10-minute COMPLETION HANDLE in the URL fragment (#…), which
//      is never sent to any server.
//   4. POST /auth/google/complete/preview, then /auth/google/complete — the
//      signed-in app must explicitly claim the result: the session's account
//      must be the account that started the flow, and the user confirms the
//      Google address shown. Only then are the tokens stored in gmail_tokens.
//
// Only SHA-256 hashes of the ticket, state, nonce and handle are stored. Parked
// tokens are wiped on completion, rejection, cancellation and expiry (never
// revoked — revoking cancels the app's whole grant for that Google user). New
// log lines carry fixed event codes only: no codes, tokens, state/nonce/ticket/
// handle values, Google addresses or account ids. Optional PKCE (S256) is
// enabled with GMAIL_OAUTH_PKCE=true once verified against Google for this
// client; by default a code whose callback fails the browser check is redeemed
// and discarded so it cannot be injected into another flow.

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];
const REQUIRED_GMAIL_SCOPES = GMAIL_SCOPES.slice(0, 2);

const TICKET_TTL_MS  = 2 * 60 * 1000;
const FLOW_TTL_MS    = 10 * 60 * 1000;
const HANDLE_TTL_MS  = 10 * 60 * 1000;
const OAUTH_NONCE_COOKIE = 'plumbline_goauth';
const OAUTH_VALUE_RE     = /^[A-Za-z0-9_-]{43}$/;          // 32 random bytes, base64url
const GMAIL_ERROR_CODES  = new Set([
  'oauth_disabled', 'not_configured', 'state_invalid', 'access_restricted', 'oauth_error',
  'missing_scopes', 'callback_failed', 'session_required', 'too_many_attempts', 'restart_required',
  'signed_in_other_account',
]);
const gmailStartLimit    = createLimiter({ name: 'gmail-oauth-start',      windowMs: 10 * MIN, max: 10 });
const gmailStartIpLimit  = createLimiter({ name: 'gmail-oauth-start-ip',   windowMs: 10 * MIN, max: 30 });
const gmailCompleteLimit = createLimiter({ name: 'gmail-oauth-complete',   windowMs: 10 * MIN, max: 20 });
const gmailCompleteIpLimit = createLimiter({ name: 'gmail-oauth-complete-ip', windowMs: 10 * MIN, max: 60 });
const gmailLaunchIpLimit = createLimiter({ name: 'gmail-oauth-launch-ip',  windowMs: 10 * MIN, max: 30 });
const gmailCallbackIpLimit = createLimiter({ name: 'gmail-oauth-callback-ip', windowMs: 10 * MIN, max: 30 });
const MAX_LIVE_PARKED = 3;

// FRONTEND_URL may be a comma-separated CORS list; the default landing is the first entry.
function frontendBase() {
  return frontendOrigins()[0] || 'http://localhost:5173';
}
function backendOrigin() {
  try { return new URL(process.env.GOOGLE_REDIRECT_URI).origin; } catch { return ''; }
}
const nowIso   = () => new Date().toISOString();
const isoIn    = (ms) => new Date(Date.now() + ms).toISOString();
const sha256   = (v) => crypto.createHash('sha256').update(v).digest('hex');
const random43 = () => crypto.randomBytes(32).toString('base64url');
const pkceOn   = () => process.env.GMAIL_OAUTH_PKCE === 'true';
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}
function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}
function gmailRedirect(res, origin, query) {
  return res.redirect(303, `${origin || frontendBase()}/?${query}`);
}
function gmailFail(res, code, origin) {
  return gmailRedirect(res, origin, `gmail_error=${GMAIL_ERROR_CODES.has(code) ? code : 'oauth_error'}`);
}
function oauthNonceCookieOptions(withMaxAge) {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'lax',          // sent on Google's top-level redirect back; Strict would not be
    path:     '/auth/google', // covers /auth/google/launch and /auth/google/callback only
    ...(withMaxAge ? { maxAge: FLOW_TTL_MS } : {}),
  };
}
const oauthLog = (event) => console.log(`[Gmail OAuth] ${event}`);

// JSON + allowed Origin (utils/appRequest.js): forces a CORS preflight, so
// other sites cannot start, preview or complete a connection with the cookie.

function failFlow(id, code) {
  db.prepare(`
    UPDATE gmail_oauth_flows
    SET status = 'failed', failure = ?, ticket_hash = NULL, state_hash = NULL, nonce_hash = NULL,
        pkce_verifier = NULL, handle_hash = NULL, google_email = NULL, p_access_token = NULL,
        p_refresh_token = NULL, p_expiry = NULL, updated_at = ?
    WHERE id = ?
  `).run(code, nowIso(), id);
}

/**
 * Expire abandoned attempts and wipe parked tokens; prune day-old rows.
 * Runs on its own 60-second timer (never on the request path), so parked tokens
 * outlive their 10-minute handle by at most about a minute. Discarded tokens are
 * wiped, never revoked: a revoke cancels the app's whole grant for that Google
 * user and could kill a live or in-progress connection for the same account.
 * All timestamps here are written by this module as ISO strings, so plain text
 * comparisons are exact and can use the indexes.
 */
function expireGmailFlows() {
  const t = nowIso();
  const wipe = `ticket_hash = NULL, state_hash = NULL, nonce_hash = NULL, pkce_verifier = NULL,
        handle_hash = NULL, google_email = NULL, p_access_token = NULL, p_refresh_token = NULL,
        p_expiry = NULL, updated_at = @t`;
  let n = 0;
  n += db.prepare(`UPDATE gmail_oauth_flows SET status = 'expired', ${wipe} WHERE status = 'parked' AND handle_expires <= @t`).run({ t }).changes;
  n += db.prepare(`UPDATE gmail_oauth_flows SET status = 'expired', ${wipe} WHERE status IN ('started', 'launched') AND flow_expires <= @t`).run({ t }).changes;
  n += db.prepare(`UPDATE gmail_oauth_flows SET status = 'expired', ${wipe} WHERE status IN ('returned', 'finishing') AND updated_at <= @stuck`)
    .run({ t, stuck: new Date(Date.now() - FLOW_TTL_MS).toISOString() }).changes;
  n += db.prepare('DELETE FROM gmail_oauth_flows WHERE created_at <= ?').run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).changes;
  return n;
}
setInterval(() => { try { expireGmailFlows(); } catch (err) { oauthLog(`sweep failed: ${err?.code || err?.name || 'error'}`); } }, 60 * 1000).unref();

// Without PKCE, a code whose callback fails the browser/account checks is
// redeemed and discarded so it can never be injected into another flow
// (tokens dropped unread). With PKCE the code is bound to this flow's verifier,
// which was just wiped, so it is already unusable and is left alone.
function burnCode(code, verifier) {
  if (verifier || typeof code !== 'string' || !code || code.length > 2048) return;
  createBaseClient().getToken(code).then(() => {}, () => {});
}

// ── POST /auth/google/start ───────────────────────────────────────────────────
router.post('/google/start', requireAppRequest, requireAuth.strict, (req, res) => {
  noStore(res);
  if (process.env.GMAIL_OAUTH_ENABLED !== 'true') {
    return res.status(403).json({ error: 'Gmail connection is not available yet.', code: 'oauth_disabled' });
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !backendOrigin()) {
    oauthLog('start refused: not configured');
    return res.status(503).json({ error: 'Gmail connection is not configured.', code: 'not_configured' });
  }
  const wait = gmailStartLimit.hit(String(req.userId)) || gmailStartIpLimit.hit(clientIpKey(req));
  if (wait) {
    return res.status(429).set('Retry-After', String(wait)).json({ error: 'Too many Gmail connection attempts.', code: 'too_many_attempts' });
  }
  const parked = db.prepare(`
    SELECT COUNT(*) AS n FROM gmail_oauth_flows
    WHERE user_id = ? AND status = 'parked' AND julianday(handle_expires) > julianday('now')
  `).get(req.userId).n;
  if (parked >= MAX_LIVE_PARKED) {
    return res.status(429).json({ error: 'Finish or cancel your other Gmail connection first.', code: 'too_many_attempts' });
  }
  // A new attempt supersedes this account's attempts that have not reached
  // Google's callback yet. A parked result is never touched (it may be the one
  // the user is signing in to claim on another device); it expires on its own.
  const t = nowIso();
  db.prepare(`
    UPDATE gmail_oauth_flows
    SET status = 'failed', failure = 'superseded', ticket_hash = NULL, state_hash = NULL,
        nonce_hash = NULL, pkce_verifier = NULL, updated_at = ?
    WHERE user_id = ? AND status IN ('started', 'launched')
  `).run(t, req.userId);

  const ticket = random43();
  const origin = frontendOrigins().includes(req.headers.origin) ? req.headers.origin : null;
  db.prepare(`
    INSERT INTO gmail_oauth_flows (user_id, status, return_origin, ticket_hash, ticket_expires, flow_expires, created_at, updated_at)
    VALUES (?, 'started', ?, ?, ?, ?, ?, ?)
  `).run(req.userId, origin, sha256(ticket), isoIn(TICKET_TTL_MS), isoIn(FLOW_TTL_MS), t, t);
  oauthLog('attempt started');
  return res.json({ launchUrl: `${backendOrigin()}/auth/google/launch?t=${ticket}` });
});

// ── /auth/google/launch ───────────────────────────────────────────────────────
// GET ?t= is used by the Android app (its WebView hands GET navigations to the
// external browser; a POST would stay inside the WebView). Desktop and Safari
// submit a top-level form POST instead, so the ticket stays out of the URL and
// browser history there.
function launch(req, res, ticket) {
  noStore(res);
  if (process.env.GMAIL_OAUTH_ENABLED !== 'true') return gmailFail(res, 'oauth_disabled');
  if (gmailLaunchIpLimit.hit(clientIpKey(req))) return gmailFail(res, 'too_many_attempts');
  if (typeof ticket !== 'string' || !OAUTH_VALUE_RE.test(ticket)) {
    oauthLog('launch rejected: malformed ticket');
    return gmailFail(res, 'state_invalid');
  }
  const state    = random43();
  const nonce    = random43();
  const verifier = pkceOn() ? crypto.randomBytes(48).toString('base64url') : null;
  // Atomic single use: an unknown, used or expired ticket matches nothing.
  // (RETURNING lists only columns this UPDATE does not change.)
  const flow = db.prepare(`
    UPDATE gmail_oauth_flows
    SET status = 'launched', ticket_hash = NULL, state_hash = ?, nonce_hash = ?, pkce_verifier = ?, updated_at = ?
    WHERE ticket_hash = ? AND status = 'started'
      AND julianday(ticket_expires) > julianday('now') AND julianday(flow_expires) > julianday('now')
    RETURNING id, user_id AS userId, return_origin AS origin
  `).get(sha256(state), sha256(nonce), verifier, nowIso(), sha256(ticket));
  if (!flow) {
    oauthLog('launch rejected: unknown, used or expired ticket');
    return gmailFail(res, 'state_invalid');
  }
  if (!isAccountActive(flow.userId)) {
    failFlow(flow.id, 'account_inactive');
    oauthLog('launch rejected: account not active');
    return gmailFail(res, 'state_invalid', flow.origin);
  }
  res.cookie(OAUTH_NONCE_COOKIE, nonce, oauthNonceCookieOptions(true));
  const url = createBaseClient().generateAuthUrl({
    access_type: 'offline',
    scope:       GMAIL_SCOPES,
    prompt:      'consent',
    state,
    ...(verifier ? { code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
  });
  oauthLog('launched');
  return res.redirect(303, url);
}
router.get('/google/launch', (req, res) => launch(req, res, req.query.t));
router.post('/google/launch', express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
  // A top-level form POST from the app: the Origin must be an app origin.
  if (!originAllowed(req.headers.origin)) { noStore(res); return gmailFail(res, 'state_invalid'); }
  return launch(req, res, req.body?.t);
});

// ── GET /auth/google (retired) ────────────────────────────────────────────────
// The single-step, cookie-only start. Retired so a cross-site link or <img>
// can never start or disturb an attempt; the app now uses POST /google/start.
router.get('/google', (req, res) => {
  noStore(res);
  return gmailFail(res, 'restart_required');
});

// ── GET /auth/google/callback ─────────────────────────────────────────────────
router.get('/google/callback', async (req, res) => {
  noStore(res);
  const nonce = req.cookies?.[OAUTH_NONCE_COOKIE];
  const { code, state, error } = req.query;

  if (process.env.GMAIL_OAUTH_ENABLED !== 'true') return gmailFail(res, 'oauth_disabled');
  if (gmailCallbackIpLimit.hit(clientIpKey(req))) return gmailFail(res, 'too_many_attempts');
  if (typeof state !== 'string' || !OAUTH_VALUE_RE.test(state)) {
    oauthLog('callback rejected: missing or malformed state');
    return gmailFail(res, 'state_invalid');
  }

  // Consume atomically (one synchronous transaction): unknown, expired or
  // already-used state matches nothing. The nonce hash and PKCE verifier are
  // read BEFORE they are wiped (UPDATE … RETURNING would yield the wiped values).
  const flow = db.transaction((stateHash) => {
    const f = db.prepare(`
      SELECT id, user_id AS userId, nonce_hash AS nonceHash, pkce_verifier AS verifier, return_origin AS origin
      FROM gmail_oauth_flows
      WHERE state_hash = ? AND status = 'launched' AND julianday(flow_expires) > julianday('now')
    `).get(stateHash);
    if (!f) return null;
    const n = db.prepare(`
      UPDATE gmail_oauth_flows
      SET status = 'returned', state_hash = NULL, nonce_hash = NULL, pkce_verifier = NULL, updated_at = ?
      WHERE id = ? AND status = 'launched'
    `).run(nowIso(), f.id).changes;
    return n === 1 ? f : null;
  })(sha256(state));
  if (!flow) {
    // The nonce cookie is left alone: it may belong to the browser's current
    // attempt (a stale tab or a cross-site link must not disturb it).
    oauthLog('callback rejected: unknown, expired or reused state');
    return gmailFail(res, 'state_invalid');
  }
  // This attempt is now consumed; its browser nonce is single-use.
  res.clearCookie(OAUTH_NONCE_COOKIE, oauthNonceCookieOptions(false));
  const reject = (failure, errCode = 'state_invalid', { burn = false } = {}) => {
    failFlow(flow.id, failure);
    if (burn && !error) burnCode(code, flow.verifier);
    oauthLog(`callback rejected: ${failure}`);
    return gmailFail(res, errCode, flow.origin);
  };

  // Must return to the browser that launched it (blocks swapped consent links).
  if (typeof nonce !== 'string' || !OAUTH_VALUE_RE.test(nonce) || !sameHash(sha256(nonce), flow.nonceHash)) {
    return reject('browser_mismatch', 'state_invalid', { burn: true });
  }
  // If this browser is signed in, it must be the same Plumbline account.
  const r = resolveSession(req);
  if (r.status === 'conflict' || (r.status === 'ok' && r.session.userId !== flow.userId)) {
    return reject('signed_in_other_account', 'signed_in_other_account', { burn: true });
  }
  if (!isAccountActive(flow.userId)) {
    return reject('account_inactive', 'state_invalid', { burn: true });
  }
  if (error) {
    // Raw Google error strings are never logged or echoed.
    return reject(error === 'access_denied' ? 'access_denied' : 'google_error',
      error === 'access_denied' ? 'access_restricted' : 'oauth_error');
  }
  if (typeof code !== 'string' || !code || code.length > 2048) return reject('bad_code', 'oauth_error');

  const client = createBaseClient();
  try {
    const { tokens } = await client.getToken(flow.verifier ? { code, codeVerifier: flow.verifier } : code);
    client.setCredentials(tokens);
    const oauth2   = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    const email    = typeof data?.email === 'string' ? data.email : '';
    if (!email || !tokens?.access_token) throw Object.assign(new Error('incomplete token response'), { code: 'incomplete' });

    // Both Gmail scopes must have been granted (granular consent can untick them).
    const granted = new Set(String(tokens.scope || '').split(/\s+/));
    if (!REQUIRED_GMAIL_SCOPES.every(sc => granted.has(sc))) {
      return reject('missing_scopes', 'missing_scopes');     // tokens are dropped, never stored
    }

    // Park the result — attached to no account until the app completes it.
    const handle = random43();
    db.prepare(`
      UPDATE gmail_oauth_flows
      SET status = 'parked', handle_hash = ?, handle_expires = ?, google_email = ?,
          p_access_token = ?, p_refresh_token = ?, p_expiry = ?, updated_at = ?
      WHERE id = ? AND status = 'returned'
    `).run(sha256(handle), isoIn(HANDLE_TTL_MS), email, tokens.access_token,
           tokens.refresh_token ?? null, tokens.expiry_date ?? null, nowIso(), flow.id);
    oauthLog('callback ok: awaiting completion');
    return res.redirect(303, `${flow.origin || frontendBase()}/#gmail_complete=${handle}`);
  } catch (err) {
    failFlow(flow.id, 'callback_failed');
    // Never log err.message here: token-endpoint errors can echo request data.
    oauthLog(`callback failed: ${err?.code || err?.name || 'error'}`);
    return gmailFail(res, 'callback_failed', flow.origin);
  }
});

// ── POST /auth/google/complete/preview ────────────────────────────────────────
// Read-only: returns the Google address of a parked result so the user can
// confirm it. Never consumes the handle.
function completionGate(req, res) {
  const wait = gmailCompleteLimit.hit(String(req.userId)) || gmailCompleteIpLimit.hit(clientIpKey(req));
  if (wait) {
    res.status(429).set('Retry-After', String(wait)).json({ error: 'Too many attempts. Please wait a few minutes.', code: 'too_many_attempts' });
    return null;
  }
  const handle = req.body?.handle;
  if (typeof handle !== 'string' || !OAUTH_VALUE_RE.test(handle)) {
    res.status(400).json({ error: 'This Gmail connection link is not valid.', code: 'state_invalid' });
    return null;
  }
  return handle;
}

router.post('/google/complete/preview', requireAppRequest, requireAuth.strict, (req, res) => {
  noStore(res);
  const handle = completionGate(req, res);
  if (!handle) return;
  const flow = db.prepare(`
    SELECT user_id AS userId, google_email AS googleEmail FROM gmail_oauth_flows
    WHERE handle_hash = ? AND status = 'parked' AND julianday(handle_expires) > julianday('now')
  `).get(sha256(handle));
  if (!flow) return res.status(410).json({ error: 'This Gmail connection link expired or was already used.', code: 'state_invalid' });
  if (flow.userId !== req.userId) {
    // Not consumed: the user can sign out and sign in with the right account.
    return res.status(403).json({ error: 'This Gmail connection was started from a different Plumbline account.', code: 'account_mismatch' });
  }
  return res.json({ googleEmail: flow.googleEmail });
});

// ── POST /auth/google/complete ────────────────────────────────────────────────
// Body: { handle, confirm: true } connects; { handle, confirm: false } cancels.
router.post('/google/complete', requireAppRequest, requireAuth.strict, (req, res) => {
  noStore(res);
  const handle = completionGate(req, res);
  if (!handle) return;
  const confirm = req.body?.confirm === true;
  const userId  = req.userId;

  // One synchronous transaction: consume (single use), verify the account,
  // store the tokens for that account only, wipe the parked copy.
  let outcome;
  db.transaction(() => {
    const flow = db.prepare(`
      UPDATE gmail_oauth_flows SET status = 'finishing', handle_hash = NULL, updated_at = ?
      WHERE handle_hash = ? AND status = 'parked' AND julianday(handle_expires) > julianday('now')
      RETURNING id, user_id AS userId, google_email AS email,
                p_access_token AS accessToken, p_refresh_token AS refreshToken, p_expiry AS expiry
    `).get(nowIso(), sha256(handle));
    if (!flow) { outcome = 'expired'; return; }
    if (flow.userId !== userId) { failFlow(flow.id, 'account_mismatch'); outcome = 'mismatch'; return; }
    if (!confirm) { failFlow(flow.id, 'cancelled'); outcome = 'cancelled'; return; }

    const existing = db.prepare('SELECT email, refresh_token AS refreshToken, access_token AS accessToken FROM gmail_tokens WHERE user_id = ?').get(userId);
    const sameAddress = existing && String(existing.email).toLowerCase() === String(flow.email).toLowerCase();
    const refresh = flow.refreshToken || (sameAddress ? existing.refreshToken : null);
    if (!refresh) { failFlow(flow.id, 'no_refresh_token'); outcome = 'failed'; return; }
    if (existing) {
      // Replace the whole token set — never pair a new address with an old refresh token.
      db.prepare(`
        UPDATE gmail_tokens
        SET email = ?, access_token = ?, refresh_token = ?, expiry_date = ?, sync_paused_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(flow.email, flow.accessToken, refresh, flow.expiry ?? null, userId);
    } else {
      db.prepare(`
        INSERT INTO gmail_tokens (email, access_token, refresh_token, expiry_date, user_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(flow.email, flow.accessToken, refresh, flow.expiry ?? null, userId);
    }
    db.prepare(`
      UPDATE gmail_oauth_flows
      SET status = 'connected', google_email = NULL, p_access_token = NULL, p_refresh_token = NULL,
          p_expiry = NULL, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), flow.id);
    // This account's other parked results are now moot: wipe them.
    const others = db.prepare(`
      SELECT id FROM gmail_oauth_flows WHERE user_id = ? AND status = 'parked' AND id <> ?
    `).all(userId, flow.id);
    for (const o of others) failFlow(o.id, 'superseded');
    outcome = 'connected';
  })();

  if (outcome === 'expired') {
    return res.status(410).json({ error: 'This Gmail connection link expired or was already used.', code: 'state_invalid' });
  }
  if (outcome === 'mismatch') {
    oauthLog('completion rejected: account mismatch');
    return res.status(403).json({ error: 'This Gmail connection was started from a different Plumbline account.', code: 'account_mismatch' });
  }
  if (outcome === 'cancelled') {
    oauthLog('completion cancelled');
    return res.json({ ok: true, cancelled: true });
  }
  if (outcome !== 'connected') {
    oauthLog('completion failed');
    return res.status(502).json({ error: 'Gmail connection could not be completed.', code: 'callback_failed' });
  }
  oauthLog('connected');
  res.json({ ok: true });

  // After responding: a 30-day backfill for this account. (A replaced address's
  // tokens are simply overwritten — never revoked, see expireGmailFlows.)
  syncRecentEmails(userId, { daysBack: 30, maxPerLabel: 100 })
    .catch(err => console.error(`[Gmail OAuth] backfill failed: ${err?.code || err?.name || 'error'}`));
});

// ── GET /auth/google/attempt ──────────────────────────────────────────────────
// Coarse status of this account's latest attempt, for the app to show progress
// while the user finishes in another browser. No handles, tickets or ids.
router.get('/google/attempt', requireAuth.strict, (req, res) => {
  noStore(res);
  // This account's latest attempt only (user_id index); expiry is computed for
  // that row here — the sweep itself never runs on the request path.
  const f = db.prepare(`
    SELECT CASE
             WHEN status = 'parked' AND handle_expires <= @t THEN 'expired'
             WHEN status IN ('started', 'launched') AND flow_expires <= @t THEN 'expired'
             ELSE status END AS status,
           failure
    FROM gmail_oauth_flows
    WHERE user_id = @u AND created_at > @since
    ORDER BY id DESC LIMIT 1
  `).get({ t: nowIso(), u: req.userId, since: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
  const map = {
    started: 'waiting_for_google', launched: 'waiting_for_google', returned: 'waiting_for_google',
    parked: 'waiting_for_confirmation', finishing: 'waiting_for_confirmation',
    connected: 'connected', expired: 'expired', failed: 'failed',
  };
  const status = f ? (map[f.status] || 'failed') : 'none';
  const SAFE_FAILURES = new Set(['access_denied', 'missing_scopes', 'cancelled', 'superseded', 'account_mismatch',
    'signed_in_other_account', 'callback_failed', 'browser_mismatch']);
  return res.json({ status, ...(status === 'failed' && SAFE_FAILURES.has(f.failure) ? { reason: f.failure } : {}) });
});

router.get('/gmail-status', requireAuth.strict, (req, res) => {
  // `enabled` tells the frontend whether the Connect button should be active.
  // False until Google OAuth verification is complete and GMAIL_OAUTH_ENABLED=true is set.
  const enabled = process.env.GMAIL_OAUTH_ENABLED === 'true';
  const row = db.prepare('SELECT email FROM gmail_tokens WHERE user_id = ?').get(req.userId);
  res.json(row
    ? { connected: true,  email: row.email, enabled }
    : { connected: false, email: null,      enabled }
  );
});

router.delete('/gmail-disconnect', requireAuth.strict, async (req, res) => {
  const row = db.prepare('SELECT email, refresh_token, access_token FROM gmail_tokens WHERE user_id = ?').get(req.userId);
  db.prepare('DELETE FROM gmail_tokens WHERE user_id = ?').run(req.userId);
  oauthLog('disconnected');
  res.json({ ok: true });

  // Best effort: also revoke the grant at Google so the token stops working —
  // unless another Plumbline account (or a pending attempt) uses the same
  // Google address (revoking removes the app's whole grant for that Google user).
  if (row && !addressInUse(row.email, { exceptUserId: req.userId })) {
    const ok = await revokeGoogleToken(row.refresh_token || row.access_token);
    if (!ok) oauthLog('revoke at Google failed (deleted locally)');
  }
});

module.exports = router;
module.exports.loginLimits = loginLimits;   // for tests
module.exports.knownLoginIps = knownLoginIps;
module.exports.gmailStartLimit = gmailStartLimit;
module.exports.gmailCompleteLimit = gmailCompleteLimit;
module.exports.gmailLaunchIpLimit = gmailLaunchIpLimit;
module.exports.gmailLimits = { gmailStartLimit, gmailStartIpLimit, gmailCompleteLimit, gmailCompleteIpLimit, gmailLaunchIpLimit, gmailCallbackIpLimit };
module.exports.expireGmailFlows = expireGmailFlows;
