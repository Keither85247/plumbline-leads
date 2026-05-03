require('dotenv').config();

// ── Sentry — must be initialised before any other requires ───────────────────
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
  });
  console.log('[Sentry] Backend error tracking enabled');
}

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');

const leadsRouter      = require('./routes/leads');
const twilioRouter     = require('./routes/twilio');
const transcribeRouter = require('./routes/transcribe');
const callsRouter      = require('./routes/calls');
const translateRouter  = require('./routes/translate');
const tokenRouter      = require('./routes/token');
const contactsRouter   = require('./routes/contacts');
const emailsRouter     = require('./routes/emails');
const messagesRouter   = require('./routes/messages');
const countsRouter     = require('./routes/counts');
const authRouter       = require('./routes/auth');
const adminRouter      = require('./routes/admin');
const pushRouter       = require('./routes/push');
const settingsRouter   = require('./routes/settings');
const requireAuth      = require('./middleware/requireAuth');

const { startPolling }          = require('./jobs/gmailPoller');
const { backfillMissingLabels } = require('./services/gmailService');

// ── One-time owner password reset ─────────────────────────────────────────────
// Set RESET_OWNER_PASSWORD=newpassword (and optionally RESET_OWNER_EMAIL=email)
// in Render env vars, deploy once, log in, then remove both vars and deploy again.
if (process.env.RESET_OWNER_PASSWORD) {
  try {
    const bcrypt = require('bcrypt');
    const db     = require('./db');
    const hash   = bcrypt.hashSync(process.env.RESET_OWNER_PASSWORD, 10);
    const email  = (process.env.RESET_OWNER_EMAIL || '').toLowerCase().trim();

    let result;
    if (email) {
      // Update by email — also promote to owner if not already
      result = db.prepare(
        'UPDATE users SET password_hash = ?, is_owner = 1 WHERE LOWER(email) = ?'
      ).run(hash, email);
      // If user doesn't exist yet, create them as owner
      if (result.changes === 0) {
        db.prepare(
          'INSERT INTO users (email, display_name, password_hash, is_owner) VALUES (?, ?, ?, 1)'
        ).run(email, email, hash);
        console.log('[RESET] Owner account created:', email);
      } else {
        console.log('[RESET] Password reset for:', email);
      }
    } else {
      // Fall back to updating any owner account
      result = db.prepare('UPDATE users SET password_hash = ? WHERE is_owner = 1').run(hash);
      if (result.changes > 0) {
        console.log('[RESET] Owner password reset successfully.');
      } else {
        console.warn('[RESET] No owner account found and RESET_OWNER_EMAIL not set — nothing changed.');
      }
    }
  } catch (err) {
    console.error('[RESET] Password reset failed:', err.message);
  }
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ─────────────────────────────────────────────────────────────────────
// credentials:'include' on every frontend request means the browser requires
// a specific, non-wildcard Access-Control-Allow-Origin header. If this is wrong
// or missing, browsers throw TypeError: Failed to fetch (network-level block).
//
// FRONTEND_URL can be a single origin or a comma-separated list:
//   https://plumbline-leads.vercel.app
//   https://plumbline-leads.vercel.app,https://app.plumblineleads.com
//
// All Vercel deployment aliases beyond the production URL must be added here if
// they are used as entry points. Vercel preview URLs (git-branch deploys) will
// be rejected unless explicitly listed.

const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Capacitor Android WebView always sends one of these two origins regardless of
// the FRONTEND_URL env var. Allow them unconditionally so the Android app works
// in every environment without touching Render config.
const CAPACITOR_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

if (process.env.NODE_ENV === 'production' && ALLOWED_ORIGINS.length === 0) {
  console.error('[CORS] FATAL: FRONTEND_URL is not set. All credentialed requests will fail with TypeError: Failed to fetch.');
} else {
  console.log('[CORS] Allowed origins:', ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : ['(any — dev mode)']);
}

const corsOptions = {
  credentials: true,
  origin(requestOrigin, callback) {
    // No Origin header = same-origin request (Twilio webhooks, health checks, etc.)
    if (!requestOrigin) {
      return callback(null, true);
    }

    // Dev fallback: no ALLOWED_ORIGINS configured → reflect whatever origin asked
    // This is safe because in dev the Vite proxy makes all requests same-origin.
    if (ALLOWED_ORIGINS.length === 0) {
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.includes(requestOrigin) || CAPACITOR_ORIGINS.has(requestOrigin)) {
      return callback(null, true);
    }

    // Log the rejection so it shows in Render's log stream — this is the primary
    // diagnostic for "TypeError: Failed to fetch" when env vars appear correct.
    console.warn(`[CORS] Rejected origin: "${requestOrigin}" — not in allowed list: [${ALLOWED_ORIGINS.join(', ')}]`);
    return callback(null, false);
  },
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// ── Request origin logger ─────────────────────────────────────────────────────
// Logs every cross-origin request so you can see exactly what origins hit the
// backend and whether they match FRONTEND_URL. Check Render's log stream.
app.use((req, _res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    console.log(`[HTTP] ${req.method} ${req.path} — Origin: ${origin}`);
  }
  next();
});

// ── Base middleware ───────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// ── Public routes (no authentication required) ────────────────────────────────
// Health check — used by the frontend status indicator
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Auth routes: login, logout, me, Gmail OAuth callbacks
// login / logout / me are always public by definition.
// Gmail OAuth routes are also public here because the /google/callback redirect
// comes from Google's servers (no cookie). The connect button in the UI is only
// reachable when logged in, which is sufficient protection in Phase 1.
app.use('/auth', authRouter);

// Twilio webhook routes — these come from Twilio's servers, NOT from the browser.
// They must stay public; do not put requireAuth in front of them.
// This covers: /api/twilio/voice, /api/twilio/sms, /api/twilio/recording-status,
//              /api/twilio/outbound, and the Voice SDK token endpoint.
app.use('/api/twilio',       twilioRouter);
app.use('/api/twilio/token', tokenRouter);

// Transcribe — accepts audio uploads from the browser (also used in onboarding
// before auth was added). Kept public for now; add requireAuth in a later pass.
app.use('/api/transcribe', transcribeRouter);

// ── Protected routes (session cookie required) ────────────────────────────────
// requireAuth reads req.cookies.plumbline_session, looks it up in the sessions
// table, and sets req.userId. Returns 401 JSON on failure.
app.use(requireAuth);

app.use('/api/leads',    leadsRouter);
app.use('/api/calls',    callsRouter);
app.use('/api/translate', translateRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/emails',   emailsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/counts',   countsRouter);
app.use('/api/admin',    adminRouter);
app.use('/api/push',     pushRouter);
app.use('/api/settings', settingsRouter);

// ── TEMPORARY MIGRATION ENDPOINT — REMOVE AFTER USE ──────────────────────────
app.post('/api/migrate', (req, res) => {
  const db = require('./db');
  const { leads = [], calls = [] } = req.body;
  let leadsInserted = 0;
  let callsInserted = 0;
  const insertLead = db.prepare(`INSERT OR IGNORE INTO leads (id,transcript,raw_text,contact_name,company_name,phone_number,callback_number,summary,key_points,follow_up_text,category,source,recording_url,status,archived,created_at) VALUES (@id,@transcript,@raw_text,@contact_name,@company_name,@phone_number,@callback_number,@summary,@key_points,@follow_up_text,@category,@source,@recording_url,@status,@archived,@created_at)`);
  const insertCall = db.prepare(`INSERT OR IGNORE INTO calls (id,from_number,call_sid,classification,status,recording_url,duration,transcript,summary,key_points,contractor_note,outcome,created_at) VALUES (@id,@from_number,@call_sid,@classification,@status,@recording_url,@duration,@transcript,@summary,@key_points,@contractor_note,@outcome,@created_at)`);
  const runAll = db.transaction(() => {
    for (const lead of leads) leadsInserted += insertLead.run(lead).changes;
    for (const call of calls) callsInserted += insertCall.run(call).changes;
  });
  try {
    runAll();
    console.log(`[Migrate] ${leadsInserted} leads, ${callsInserted} calls`);
    res.json({ ok: true, leadsInserted, callsInserted });
  } catch (err) {
    console.error('[Migrate]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── END TEMPORARY MIGRATION ENDPOINT ─────────────────────────────────────────

// ── Error handling — must be after all routes ─────────────────────────────────
if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[Express] Unhandled error on ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  startPolling(60_000);
  backfillMissingLabels().catch(err =>
    console.error('[Startup] Label backfill error:', err.message)
  );
});
