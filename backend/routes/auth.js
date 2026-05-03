'use strict';
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const { google } = require('googleapis');
const db = require('../db');
const { oauth2Client, syncRecentEmails } = require('../services/gmailService');

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

  // Include token in response body for Safari ITP (blocked cross-origin cookies).
  return res.json({ id: user.id, email: user.email, display_name: user.display_name, is_owner: user.is_owner, token });
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
    SELECT u.id, u.email, u.display_name, u.is_owner
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
      AND s.expires_at > CURRENT_TIMESTAMP
  `).get(token);

  if (!row) {
    res.clearCookie('plumbline_session', clearOptions());
    return res.status(401).json({ error: 'Session expired' });
  }

  return res.json(row);
});

// ── Gmail OAuth ───────────────────────────────────────────────────────────────
// These routes require the user to be logged in (requireAuth applied in index.js
// before the /auth router for non-login/logout/me paths).
// In practice: the frontend only shows the "Connect Gmail" button when logged in.

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// In-memory pending state — single-tenant for now; will be keyed by userId in Phase 3
let pendingState = null;

router.get('/google', (_req, res) => {
  pendingState = Math.random().toString(36).slice(2);

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope:       GMAIL_SCOPES,
    prompt:      'consent',
    state:       pendingState,
  });

  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('[Auth] OAuth error:', error);
    return res.redirect(`${FRONTEND_URL}?gmail_error=${encodeURIComponent(error)}`);
  }

  if (!code || state !== pendingState) {
    return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
  }
  pendingState = null;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2   = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const email    = data.email;

    const existing = db.prepare('SELECT id FROM gmail_tokens LIMIT 1').get();
    if (existing) {
      db.prepare(`
        UPDATE gmail_tokens
        SET email         = ?,
            access_token  = ?,
            refresh_token = COALESCE(?, refresh_token),
            expiry_date   = ?,
            updated_at    = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        email,
        tokens.access_token,
        tokens.refresh_token ?? null,
        tokens.expiry_date   ?? null,
        existing.id,
      );
    } else {
      db.prepare(`
        INSERT INTO gmail_tokens (email, access_token, refresh_token, expiry_date)
        VALUES (?, ?, ?, ?)
      `).run(
        email,
        tokens.access_token,
        tokens.refresh_token ?? null,
        tokens.expiry_date   ?? null,
      );
    }

    console.log(`[Auth] Gmail connected: ${email}`);
    res.redirect(`${FRONTEND_URL}?gmail_connected=1`);

    syncRecentEmails({ daysBack: 30, maxPerLabel: 100 })
      .catch(err => console.error('[Auth] Backfill failed:', err.message));
  } catch (err) {
    console.error('[Auth] Callback failed:', err.message);
    res.redirect(`${FRONTEND_URL}?gmail_error=callback_failed`);
  }
});

router.get('/gmail-status', (_req, res) => {
  const row = db.prepare('SELECT email FROM gmail_tokens LIMIT 1').get();
  res.json(row
    ? { connected: true,  email: row.email }
    : { connected: false, email: null }
  );
});

router.delete('/gmail-disconnect', (_req, res) => {
  db.prepare('DELETE FROM gmail_tokens').run();
  console.log('[Auth] Gmail disconnected');
  res.json({ ok: true });
});

module.exports = router;
