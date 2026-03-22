const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');
const db = require('../db');
const { createLeadFromTranscript, isDuplicate } = require('./leads');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Caller classification
// Uses prior lead history to classify an incoming number before routing.
// ---------------------------------------------------------------------------
function classifyIncomingCall(fromNumber) {
  // Anonymous / blocked caller
  if (!fromNumber || fromNumber === 'anonymous' || fromNumber === 'blocked') {
    return 'Likely Spam';
  }

  // Look up all prior leads associated with this number
  const priorLeads = db.prepare(
    'SELECT category FROM leads WHERE phone_number = ? OR callback_number = ?'
  ).all(fromNumber, fromNumber);

  if (priorLeads.length === 0) {
    // No history — treat as a potential new lead
    return 'Likely Lead';
  }

  const categories = priorLeads.map(l => l.category || 'Lead');

  // Priority order: Spam > Vendor > Existing Customer > known caller
  if (categories.includes('Spam')) return 'Likely Spam';
  if (categories.includes('Vendor')) return 'Vendor';
  if (categories.includes('Existing Customer')) return 'Existing Customer';

  // They've called before but weren't categorised as above
  return 'Existing Customer';
}

// Log an inbound call to the calls table
function logCall(fromNumber, callSid, classification) {
  try {
    db.prepare(
      'INSERT INTO calls (from_number, call_sid, classification) VALUES (?, ?, ?)'
    ).run(fromNumber || null, callSid || null, classification);
  } catch (err) {
    console.error('[Twilio] Failed to log call:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Recording download helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function attemptDownload(url, destPath) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return Promise.reject(new Error('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not set in .env'));
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const options = { headers: { Authorization: `Basic ${credentials}` } };

    protocol.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        file.close(() => { try { fs.unlinkSync(destPath); } catch {} });
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', (err) => {
      file.close(() => { try { fs.unlinkSync(destPath); } catch {} });
      reject(err);
    });
  });
}

// Twilio occasionally returns 404 right after the webhook fires because
// the recording hasn't finished processing. Retry with backoff.
async function downloadToTemp(url, destPath) {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 2000;
  const audioUrl = url.endsWith('.mp3') ? url : `${url}.mp3`;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[Twilio] Download attempt ${attempt}/${MAX_ATTEMPTS}: ${audioUrl}`);
    try {
      await attemptDownload(audioUrl, destPath);
      console.log(`[Twilio] Download succeeded on attempt ${attempt}`);
      return destPath;
    } catch (err) {
      lastError = err;
      console.warn(`[Twilio] Download attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  console.error(`[Twilio] All ${MAX_ATTEMPTS} attempts failed. Last error: ${lastError.message}`);
  throw lastError;
}

// ---------------------------------------------------------------------------
// Voicemail TwiML helper — reused by both /voice (no contractor phone) and
// /missed (call went unanswered).
// ---------------------------------------------------------------------------
function voicemailTwiML(baseUrl) {
  const voicemailUrl = `${baseUrl}/api/twilio/voicemail`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry we missed your call. Please leave a message after the tone and we'll get back to you shortly.</Say>
  <Record
    action="${voicemailUrl}"
    method="POST"
    maxLength="120"
    playBeep="true"
    finishOnKey="#"
  />
  <Say>We did not receive a recording. Goodbye.</Say>
</Response>`;
}

// ---------------------------------------------------------------------------
// POST /api/twilio/voice
// Step 1 of incoming call flow:
//   1. Classify the caller using prior lead history
//   2. Log the call to the calls table
//   3a. If CONTRACTOR_PHONE_NUMBER is set: ring the contractor (20s timeout).
//       The <Dial action> points to /missed so Twilio falls through to voicemail
//       if the call goes unanswered.
//   3b. If no contractor phone configured: go straight to voicemail greeting.
// ---------------------------------------------------------------------------
router.post('/voice', express.urlencoded({ extended: true }), (req, res) => {
  const { From, CallSid } = req.body;

  res.setHeader('Content-Type', 'text/xml');

  if (!process.env.TWILIO_BASE_URL) {
    console.error('[Twilio] TWILIO_BASE_URL not set — cannot build callback URLs');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, there is a configuration error. Please try again later.</Say>
</Response>`);
  }

  const classification = classifyIncomingCall(From);
  logCall(From, CallSid, classification);
  console.log(`[Twilio] Incoming call from ${From || 'unknown'} — classified as: ${classification}`);

  const baseUrl = process.env.TWILIO_BASE_URL;
  const contractorPhone = process.env.CONTRACTOR_PHONE_NUMBER;

  if (contractorPhone) {
    // Ring contractor first. If unanswered, Twilio POSTs to /missed which
    // serves the voicemail prompt.
    const missedUrl = `${baseUrl}/api/twilio/missed`;
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${From || ''}" timeout="20" action="${missedUrl}" method="POST">
    <Number>${contractorPhone}</Number>
  </Dial>
</Response>`);
  }

  // No contractor phone set — go straight to voicemail
  return res.status(200).send(voicemailTwiML(baseUrl));
});

// ---------------------------------------------------------------------------
// POST /api/twilio/missed
// Called by Twilio after a <Dial> completes without being answered.
// If DialCallStatus is 'completed' the contractor answered — nothing to do.
// Otherwise serve the voicemail prompt.
// ---------------------------------------------------------------------------
router.post('/missed', express.urlencoded({ extended: true }), (req, res) => {
  const { DialCallStatus } = req.body;

  res.setHeader('Content-Type', 'text/xml');

  if (DialCallStatus === 'completed') {
    // Contractor answered — call is done, no voicemail needed
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }

  if (!process.env.TWILIO_BASE_URL) {
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  console.log(`[Twilio] Call unanswered (DialCallStatus: ${DialCallStatus}) — routing to voicemail`);
  return res.status(200).send(voicemailTwiML(process.env.TWILIO_BASE_URL));
});

// ---------------------------------------------------------------------------
// POST /api/twilio/sms
// ---------------------------------------------------------------------------
router.post('/sms', express.urlencoded({ extended: true }), async (req, res) => {
  const { From, Body } = req.body;

  if (!Body || Body.trim().length === 0) {
    return res.status(200).send('OK');
  }

  if (isDuplicate(From, Body)) {
    console.log(`[Twilio] SMS duplicate detected from ${From}, skipping`);
    return res.status(200).send('OK');
  }

  try {
    await createLeadFromTranscript({
      transcript: Body,
      rawText: Body,
      contactNameFallback: From || 'Unknown',
      phoneNumber: From || null
    });
  } catch (err) {
    console.error('Twilio SMS lead creation failed:', err);
  }

  return res.status(200).send('OK');
});

// ---------------------------------------------------------------------------
// POST /api/twilio/voicemail
// Called by Twilio after a recording completes.
// Responds immediately with TwiML, then async: download → transcribe → lead.
// ---------------------------------------------------------------------------
router.post('/voicemail', express.urlencoded({ extended: true }), async (req, res) => {
  const { RecordingUrl, From } = req.body;

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);

  if (!RecordingUrl) {
    console.error('[Twilio] Voicemail webhook: missing RecordingUrl');
    return;
  }

  console.log(`[Twilio] Voicemail from ${From || 'unknown'}, RecordingUrl: ${RecordingUrl}`);

  const tempPath = path.join(os.tmpdir(), `twilio-vm-${Date.now()}.mp3`);

  try {
    await downloadToTemp(RecordingUrl, tempPath);

    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tempPath),
    });

    fs.unlinkSync(tempPath);

    const transcript = transcription.text?.trim();

    if (!transcript) {
      console.error('[Twilio] Voicemail: transcription returned empty text');
      return;
    }

    if (isDuplicate(From, transcript)) {
      console.log(`[Twilio] Voicemail duplicate detected from ${From}, skipping`);
      return;
    }

    await createLeadFromTranscript({
      transcript,
      rawText: transcript,
      contactNameFallback: From || 'Unknown',
      phoneNumber: From || null
    });

    console.log(`[Twilio] Voicemail lead created from ${From || 'unknown'}`);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    console.error('[Twilio] Voicemail lead creation failed:', err);
  }
});

module.exports = router;
