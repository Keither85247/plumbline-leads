require('dotenv').config();
const express = require('express');
const cors    = require('cors');
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
const { startPolling }        = require('./jobs/gmailPoller');
const { backfillMissingLabels } = require('./services/gmailService');

const app  = express();
const PORT = process.env.PORT || 3001;

// In production, restrict CORS to the known frontend origin.
// In local dev (no FRONTEND_URL set), allow all origins so the Vite dev server works.
const corsOptions = process.env.FRONTEND_URL
  ? { origin: process.env.FRONTEND_URL, credentials: true }
  : {};
// Explicitly handle OPTIONS preflight for all routes.
// Without this, cross-origin POST with Content-Type: application/json
// fails because the browser's preflight request gets no CORS headers back.
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

// API routes
app.use('/api/leads',        leadsRouter);
app.use('/api/twilio',       twilioRouter);
app.use('/api/transcribe',   transcribeRouter);
app.use('/api/calls',        callsRouter);
app.use('/api/translate',    translateRouter);
app.use('/api/twilio/token', tokenRouter);
app.use('/api/contacts',     contactsRouter);
app.use('/api/emails',       emailsRouter);
app.use('/api/messages',     messagesRouter);
app.use('/api/counts',       countsRouter);

// Auth routes — at /auth (not /api/auth) so the OAuth redirect URI is a clean path
app.use('/auth', authRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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


app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  // Start Gmail inbox polling — is a no-op until Gmail is connected
  startPolling(60_000);
  // Backfill label data for any emails imported before label storage was added.
  // Runs async in background; does nothing if Gmail isn't connected or all labels already stored.
  backfillMissingLabels().catch(err =>
    console.error('[Startup] Label backfill error:', err.message)
  );
});
