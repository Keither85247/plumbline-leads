'use strict';
const express = require('express');
const router  = express.Router();
const { google } = require('googleapis');
const db = require('../db');
const { oauth2Client, syncRecentEmails } = require('../services/gmailService');

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

// After a successful connect, redirect the browser back to the frontend.
// In production, set FRONTEND_URL to your public domain.
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Single-use CSRF state token (in-memory is fine for single-tenant app)
let pendingState = null;

// ── GET /auth/google ──────────────────────────────────────────────────────────
// Initiates the OAuth consent flow. The browser navigates here directly.

router.get('/google', (_req, res) => {
  pendingState = Math.random().toString(36).slice(2);

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope:       GMAIL_SCOPES,
    prompt:      'consent', // forces refresh_token in every response
    state:       pendingState,
  });

  res.redirect(url);
});

// ── GET /auth/google/callback ─────────────────────────────────────────────────
// Google redirects here after the user grants (or denies) consent.

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

    // Resolve the connected account's email address
    const oauth2    = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data }  = await oauth2.userinfo.get();
    const email     = data.email;

    // Upsert — single row, keyed by the auto-increment id
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

    // Redirect immediately — don't make the user wait for the backfill.
    // The frontend will auto-refresh the email list as results land.
    res.redirect(`${FRONTEND_URL}?gmail_connected=1`);

    // Fire-and-forget: backfill last 30 days (up to 100 inbox + 100 sent)
    syncRecentEmails({ daysBack: 30, maxPerLabel: 100 })
      .catch(err => console.error('[Auth] Backfill failed:', err.message));
  } catch (err) {
    console.error('[Auth] Callback failed:', err.message);
    res.redirect(`${FRONTEND_URL}?gmail_error=callback_failed`);
  }
});

// ── GET /auth/gmail-status ────────────────────────────────────────────────────
// Returns whether Gmail is connected and which account.

router.get('/gmail-status', (_req, res) => {
  const row = db.prepare('SELECT email FROM gmail_tokens LIMIT 1').get();
  res.json(row
    ? { connected: true,  email: row.email }
    : { connected: false, email: null }
  );
});

// ── DELETE /auth/gmail-disconnect ─────────────────────────────────────────────
// Removes stored tokens. User must reconnect to send/receive again.

router.delete('/gmail-disconnect', (_req, res) => {
  db.prepare('DELETE FROM gmail_tokens').run();
  console.log('[Auth] Gmail disconnected');
  res.json({ ok: true });
});

module.exports = router;
