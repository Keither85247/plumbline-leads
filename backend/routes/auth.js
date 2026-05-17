'use strict';
const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcrypt');
const crypto       = require('crypto');
const { google }   = require('googleapis');
const db           = require('../db');
const requireAuth  = require('../middleware/requireAuth');
const { oauth2Client, syncRecentEmails } = require('../services/gmailService');

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

  if (!email || !password) {
    console.warn(`[Auth] Login rejected — missing email or password (origin: ${origin})`);
    return res.status(400).json({ error: 'email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  console.log(`[Auth] Login attempt: "${normalizedEmail}" from ${origin}`);

  const user = db.prepare(
    'SELECT * FROM users WHERE LOWER(email) = ?'
  ).get(normalizedEmail);

  // Server-side diagnostic log — tells you exactly why login failed in Render logs.
  // The client still gets the generic message so email existence is not leaked.
  if (!user) {
    console.warn(`[Auth] Login failed — no user found with email "${normalizedEmail}"`);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.password_hash) {
    console.warn(`[Auth] Login failed — user id=${user.id} has no password_hash set`);
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
    console.warn(`[Auth] Login failed — password mismatch for user id=${user.id} (${user.email})`);
    return res.status(401).json({ error: 'Invalid email or password' });
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
  console.log(`[Auth] ✓ Login success: user id=${user.id} (${user.email}) is_owner=${user.is_owner} — cookie SameSite=${opts.sameSite} Secure=${opts.secure} origin=${origin}`);

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

  if (!email || !password || !display_name) {
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
  let token = req.cookies?.plumbline_session;
  // Safari ITP fallback: read token from Authorization header
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) token = auth.slice(7).trim();
  }
  if (token) {
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
  let token = req.cookies?.plumbline_session;
  // Safari ITP fallback: accept Bearer token from Authorization header
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) token = auth.slice(7).trim();
  }
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const row = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.is_owner, u.access_status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
      AND s.expires_at > CURRENT_TIMESTAMP
  `).get(token);

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
// /google and /gmail-status and /gmail-disconnect all use requireAuth inline
// so they know WHICH user is connecting/querying/disconnecting.
// /google/callback comes from Google's redirect (no cookie enforcement possible),
// but the correct userId is recovered from pendingState that was set in /google.

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// In-memory pending state — stores both the CSRF state token and the userId
// so the callback can stamp the correct user when saving the token.
// Shape: { state: string, userId: number } | null
let pendingState = null;

router.get('/google', requireAuth, (req, res) => {
  // Frontend Connect button passes the session token as ?token=... because
  // top-level navigations on Capacitor Android / iOS Safari ITP / external
  // tabs don't always send the SameSite=None session cookie. The token
  // appears in this single request URL only — Referrer-Policy: no-referrer
  // below prevents it from leaking to Google via the Referer header when
  // we redirect.
  res.set('Referrer-Policy', 'no-referrer');

  // Feature flag: Gmail OAuth is disabled until Google verification is complete.
  // Set GMAIL_OAUTH_ENABLED=true in Render env vars to enable.
  if (process.env.GMAIL_OAUTH_ENABLED !== 'true') {
    console.log('[Auth] Gmail OAuth blocked — GMAIL_OAUTH_ENABLED is not set to "true"');
    return res.redirect(`${FRONTEND_URL}?gmail_error=oauth_disabled`);
  }

  // Verify required Google credentials are configured before attempting OAuth.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    console.error('[Auth] Gmail OAuth blocked — missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI');
    return res.redirect(`${FRONTEND_URL}?gmail_error=not_configured`);
  }

  const state  = Math.random().toString(36).slice(2);
  pendingState = { state, userId: req.userId };

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope:       GMAIL_SCOPES,
    prompt:      'consent',
    state,
  });

  console.log(`[Auth] Gmail OAuth redirect initiated for user ${req.userId}`);
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    const desc = req.query.error_description || '(no description)';
    // Log full detail server-side — never put raw Google error strings in the redirect URL.
    console.error(`[Auth] Gmail OAuth callback error: ${error} — ${desc} | state_match=${state === pendingState?.state}`);

    // Map Google error codes to safe frontend codes:
    //   access_denied → user not in test-user list, or app verification required, or user clicked Deny
    //   Other codes   → configuration or network problem
    const frontendCode = (error === 'access_denied') ? 'access_restricted' : 'oauth_error';
    return res.redirect(`${FRONTEND_URL}?gmail_error=${frontendCode}`);
  }

  if (!code || !pendingState || state !== pendingState.state) {
    return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
  }

  // Capture and clear the pending state atomically
  const { userId } = pendingState;
  pendingState = null;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2   = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const email    = data.email;

    // Upsert token row scoped to this specific user
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

    console.log(`[Auth] Gmail connected: ${email} for user ${userId}`);
    res.redirect(`${FRONTEND_URL}?gmail_connected=1`);

    syncRecentEmails(userId, { daysBack: 30, maxPerLabel: 100 })
      .catch(err => console.error('[Auth] Backfill failed:', err.message));
  } catch (err) {
    console.error('[Auth] Callback failed:', err.message);
    res.redirect(`${FRONTEND_URL}?gmail_error=callback_failed`);
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

router.delete('/gmail-disconnect', requireAuth, (req, res) => {
  db.prepare('DELETE FROM gmail_tokens WHERE user_id = ?').run(req.userId);
  console.log(`[Auth] Gmail disconnected for user ${req.userId}`);
  res.json({ ok: true });
});

module.exports = router;
