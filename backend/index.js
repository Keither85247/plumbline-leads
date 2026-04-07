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
const authRouter       = require('./routes/auth');
const { startPolling }        = require('./jobs/gmailPoller');
const { backfillMissingLabels } = require('./services/gmailService');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
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

// Auth routes — at /auth (not /api/auth) so the OAuth redirect URI is a clean path
app.use('/auth', authRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
