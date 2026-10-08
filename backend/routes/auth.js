'use strict';
const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcrypt');
const crypto       = require('crypto');
const { google }   = require('googleapis');
const db           = require('../db');
const requireAuth  = require('../middleware/requireAuth');
const { createBaseClient, syncRecentEmails } = require('../services/gmailService');
const { getSessionToken, lookupSession, SUSPENDED_ERROR } = require('../utils/session');
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

  // Suspended accounts cannot sign in. Checked only after the password is
  // verified, so it reveals nothing to someone without the password.
  if (user.is_suspended) {
    console.warn(`[Auth] Login refused — user id=${user.id} is suspended`);
    return res.status(403).json(SUSPENDED_ERROR);
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
  // Cookie, then Bearer (Safari ITP).
  const token = getSessionToken(req);
  if (token) {
    // Remove THIS device's push registration so notifications stop after
    // logout. Scoped to the session's own account; other devices are kept.
    // Identifiers are only type/length-checked here so rows stored before
    // validation existed can still be removed; invalid ones are skipped.
    const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
    const { pushEndpoint, fcmToken } = req.body || {};
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
  // Cookie, then Bearer (Safari ITP).
  const token = getSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  // Absolute-UTC expiry + suspension (see utils/session.js).
  const session = lookupSession(token);
  if (!session) {
    res.clearCookie('plumbline_session', clearOptions());
    return res.status(401).json({ error: 'Session expired' });
  }
  if (session.suspended) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.userId);
    res.clearCookie('plumbline_session', clearOptions());
    return res.status(401).json(SUSPENDED_ERROR);
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

  const user = db.prepare('SELECT id, is_owner, access_status FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Owners already have full access; no-op but succeed gracefully
  if (user.is_owner) {
    return res.json({ ok: true, access_status: 'owner' });
  }

  db.prepare("UPDATE users SET access_status = 'tester' WHERE id = ?").run(req.userId);
  console.log(`[Auth] Tester bypass activated for user ${req.userId}`);
  return res.json({ ok: true, access_status: 'tester' });
});

// ── Gmail OAuth ───────────────────────────────────────────────────────────────
// /google, /gmail-status and /gmail-disconnect use requireAuth inline so they
// know WHICH user is connecting/querying/disconnecting.
//
// Connection security (state):
//   • /google creates a fresh 256-bit state AND a 256-bit browser nonce per
//     attempt. Only their SHA-256 hashes are stored (gmail_oauth_states), with
//     the initiating user_id and a 10-minute expiry.
//   • The nonce is set as an httpOnly SameSite=Lax cookie scoped to
//     /auth/google. Both legs are top-level navigations to this backend, so the
//     cookie is first-party (works on Safari/ITP and in the external browser
//     Capacitor opens) and is only present in the browser that started.
//   • /google/callback consumes the state atomically (single use), rejects
//     missing/malformed/expired/reused state, a missing or wrong nonce (another
//     browser — the account-linking attack), a session cookie belonging to a
//     different account, and a deleted or suspended initiator.
//   • Each request uses a fresh OAuth2 client; no tokens are held in shared
//     state. Codes, tokens, state and nonce values are never logged.

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];
const REQUIRED_GMAIL_SCOPES = GMAIL_SCOPES.slice(0, 2);

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_NONCE_COOKIE = 'plumbline_goauth';
const OAUTH_VALUE_RE     = /^[A-Za-z0-9_-]{43}$/;          // 32 random bytes, base64url
const GMAIL_ERROR_CODES  = new Set([
  'oauth_disabled', 'not_configured', 'state_invalid', 'access_restricted',
  'oauth_error', 'missing_scopes', 'callback_failed', 'session_required', 'too_many_attempts',
]);
// Starts per user (each start invalidates the browser's previous attempt anyway).
const gmailStartLimit = createLimiter({ name: 'gmail-oauth-start', windowMs: 10 * MIN, max: 10 });

// FRONTEND_URL may be a comma-separated CORS list; redirects use the first entry.
function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
}
function gmailRedirect(res, query) {
  return res.redirect(303, `${frontendBase()}/?${query}`);
}
function gmailFail(res, code) {
  return gmailRedirect(res, `gmail_error=${GMAIL_ERROR_CODES.has(code) ? code : 'oauth_error'}`);
}
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}
function oauthNonceCookieOptions(withMaxAge) {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'lax',          // sent on Google's top-level redirect back; Strict would not be
    path:     '/auth/google', // covers /auth/google and /auth/google/callback only
    ...(withMaxAge ? { maxAge: OAUTH_STATE_TTL_MS } : {}),
  };
}

router.get('/google', (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');

  // Authenticate with the session COOKIE only. A session token carried in the
  // URL (?token=) would let an attacker send someone a link that starts a
  // Gmail connection for the ATTACKER's account inside the victim's browser —
  // the browser binding below would then be satisfied by the victim's own
  // browser. A cross-site attacker cannot plant this cookie, so the browser
  // that starts the flow is always signed in as the account it is bound to.
  const session = lookupSession(req.cookies?.plumbline_session);
  if (!session || session.suspended) {
    console.warn('[Auth] Gmail OAuth start refused — no signed-in session cookie');
    return gmailFail(res, 'session_required');
  }
  req.userId = session.userId;
  if (gmailStartLimit.hit(String(req.userId))) return gmailFail(res, 'too_many_attempts');

  // Feature flag: Gmail OAuth is disabled until Google verification is complete.
  // Set GMAIL_OAUTH_ENABLED=true in Render env vars to enable.
  if (process.env.GMAIL_OAUTH_ENABLED !== 'true') {
    console.log('[Auth] Gmail OAuth blocked — GMAIL_OAUTH_ENABLED is not set to "true"');
    return gmailFail(res, 'oauth_disabled');
  }

  // Verify required Google credentials are configured before attempting OAuth.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    console.error('[Auth] Gmail OAuth blocked — missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI');
    return gmailFail(res, 'not_configured');
  }

  // Housekeeping: drop flows that expired more than a day ago, and this user's
  // earlier unused attempts (a new start replaces the browser's nonce, so they
  // can no longer complete).
  db.prepare(`
    DELETE FROM gmail_oauth_states
    WHERE julianday(expires_at) < julianday('now', '-1 day')
       OR (user_id = ? AND used_at IS NULL)
  `).run(req.userId);

  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  db.prepare(`
    INSERT INTO gmail_oauth_states (state_hash, nonce_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(state), sha256(nonce), req.userId,
         new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(), new Date().toISOString());

  res.cookie(OAUTH_NONCE_COOKIE, nonce, oauthNonceCookieOptions(true));

  const url = createBaseClient().generateAuthUrl({
    access_type: 'offline',
    scope:       GMAIL_SCOPES,
    prompt:      'consent',
    state,
  });

  console.log(`[Auth] Gmail OAuth redirect initiated for user ${req.userId}`);
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');

  const nonce = req.cookies?.[OAUTH_NONCE_COOKIE];
  res.clearCookie(OAUTH_NONCE_COOKIE, oauthNonceCookieOptions(false));
  const { code, state, error } = req.query;

  if (process.env.GMAIL_OAUTH_ENABLED !== 'true') return gmailFail(res, 'oauth_disabled');

  // Missing or malformed state.
  if (typeof state !== 'string' || !OAUTH_VALUE_RE.test(state)) {
    console.warn('[Auth] Gmail callback rejected — missing or malformed state');
    return gmailFail(res, 'state_invalid');
  }

  // Consume atomically: unknown, expired, or already-used state matches nothing.
  const flow = db.prepare(`
    UPDATE gmail_oauth_states
    SET used_at = ?
    WHERE state_hash = ?
      AND used_at IS NULL
      AND julianday(expires_at) > julianday('now')
    RETURNING user_id AS userId, nonce_hash AS nonceHash
  `).get(new Date().toISOString(), sha256(state));
  if (!flow) {
    console.warn('[Auth] Gmail callback rejected — unknown, expired, or reused state');
    return gmailFail(res, 'state_invalid');
  }

  // Must complete in the browser that started it (blocks attaching someone
  // else's Gmail by sending them the consent link).
  if (typeof nonce !== 'string' || !OAUTH_VALUE_RE.test(nonce) || !sameHash(sha256(nonce), flow.nonceHash)) {
    console.warn(`[Auth] Gmail callback rejected — browser binding failed (user ${flow.userId})`);
    return gmailFail(res, 'state_invalid');
  }

  // If this browser is signed in, it must be the same Plumbline account.
  const sessionToken = getSessionToken(req);
  if (sessionToken) {
    const session = lookupSession(sessionToken);
    if (session && session.userId !== flow.userId) {
      console.warn(`[Auth] Gmail callback rejected — signed-in account does not match initiator (user ${flow.userId})`);
      return gmailFail(res, 'state_invalid');
    }
  }

  const initiator = db.prepare('SELECT id, is_suspended FROM users WHERE id = ?').get(flow.userId);
  if (!initiator || initiator.is_suspended) {
    console.warn('[Auth] Gmail callback rejected — initiating account unavailable');
    return gmailFail(res, 'state_invalid');
  }

  if (error) {
    // Raw Google error strings never go into the redirect URL.
    // Logged as a fixed classification only — the query value is never echoed.
    const kind = error === 'access_denied' ? 'access_restricted' : 'oauth_error';
    console.warn(`[Auth] Gmail OAuth returned an error for user ${flow.userId} (${kind})`);
    return gmailFail(res, kind);
  }
  if (typeof code !== 'string' || !code || code.length > 2048) return gmailFail(res, 'oauth_error');

  const userId = flow.userId;
  const client = createBaseClient();
  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const oauth2   = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    const email    = data?.email;
    if (!email) throw new Error('userinfo returned no email');

    // Both Gmail scopes must have been granted (granular consent can untick them).
    const granted = new Set(String(tokens?.scope || '').split(/\s+/));
    if (!REQUIRED_GMAIL_SCOPES.every(sc => granted.has(sc))) {
      console.warn(`[Auth] Gmail callback rejected — required scopes not granted (user ${userId})`);
      // Revoking cancels the app's whole grant for that Google user, so skip it
      // when that Google account is already connected to a Plumbline account.
      const inUse = db.prepare('SELECT 1 FROM gmail_tokens WHERE LOWER(email) = LOWER(?) LIMIT 1').get(email);
      if (!inUse) {
        try { await client.revokeToken(tokens.refresh_token || tokens.access_token); } catch { /* best effort */ }
      }
      return gmailFail(res, 'missing_scopes');
    }

    // Upsert token row scoped to the initiating user only
    const existing = db.prepare('SELECT id FROM gmail_tokens WHERE user_id = ?').get(userId);
    if (existing) {
      db.prepare(`
        UPDATE gmail_tokens
        SET email         = ?,
            access_token  = ?,
            refresh_token = COALESCE(?, refresh_token),
            expiry_date   = ?,
            updated_at    = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(
        email,
        tokens.access_token,
        tokens.refresh_token ?? null,
        tokens.expiry_date   ?? null,
        userId,
      );
    } else {
      db.prepare(`
        INSERT INTO gmail_tokens (email, access_token, refresh_token, expiry_date, user_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        email,
        tokens.access_token,
        tokens.refresh_token ?? null,
        tokens.expiry_date   ?? null,
        userId,
      );
    }

    console.log(`[Auth] Gmail connected for user ${userId}`);
    gmailRedirect(res, 'gmail_connected=1');

    syncRecentEmails(userId, { daysBack: 30, maxPerLabel: 100 })
      .catch(err => console.error('[Auth] Backfill failed:', err.message));
  } catch (err) {
    // Never log err.message here: token-endpoint errors can echo request data.
    console.error(`[Auth] Gmail callback failed for user ${userId}: ${err?.code || err?.name || 'error'}`);
    gmailFail(res, 'callback_failed');
  }
});

router.get('/gmail-status', requireAuth, (req, res) => {
  // `enabled` tells the frontend whether the Connect button should be active.
  // False until Google OAuth verification is complete and GMAIL_OAUTH_ENABLED=true is set.
  const enabled = process.env.GMAIL_OAUTH_ENABLED === 'true';
  const row = db.prepare('SELECT email FROM gmail_tokens WHERE user_id = ?').get(req.userId);
  res.json(row
    ? { connected: true,  email: row.email, enabled }
    : { connected: false, email: null,      enabled }
  );
});

router.delete('/gmail-disconnect', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT email, refresh_token, access_token FROM gmail_tokens WHERE user_id = ?').get(req.userId);
  db.prepare('DELETE FROM gmail_tokens WHERE user_id = ?').run(req.userId);
  console.log(`[Auth] Gmail disconnected for user ${req.userId}`);
  res.json({ ok: true });

  // Best effort: also revoke the grant at Google so the token stops working —
  // unless another Plumbline account is connected to the same Google account
  // (revoking removes the app's whole grant for that Google user).
  const sharedElsewhere = row && db.prepare(
    'SELECT 1 FROM gmail_tokens WHERE LOWER(email) = LOWER(?) AND user_id != ? LIMIT 1'
  ).get(row.email, req.userId);
  if (row && !sharedElsewhere) {
    try {
      await createBaseClient().revokeToken(row.refresh_token || row.access_token);
    } catch {
      console.warn(`[Auth] Gmail revoke at Google failed for user ${req.userId} (deleted locally)`);
    }
  }
});

module.exports = router;
module.exports.loginLimits = loginLimits;   // for tests
module.exports.knownLoginIps = knownLoginIps;
module.exports.gmailStartLimit = gmailStartLimit;
