const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
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
// Voicemail TwiML helper — appends voicemail verbs onto an existing
// VoiceResponse object. Reused by /voice (no contractor) and /missed-call.
// ---------------------------------------------------------------------------
function buildVoicemailTwiml(twiml, baseUrl) {
  twiml.say("Sorry we missed your call. Please leave a message after the tone and we'll get back to you shortly.");
  twiml.record({
    action: `${baseUrl}/api/twilio/voicemail`,
    method: 'POST',
    maxLength: 120,
    playBeep: true,
    finishOnKey: '#',
  });
  twiml.say('We did not receive a recording. Goodbye.');
}

// ---------------------------------------------------------------------------
// POST /api/twilio/voice
// Step 1 of incoming call flow:
//   1. Classify the caller using prior lead history
//   2. Log the call to the calls table
//   3a. If CONTRACTOR_PHONE_NUMBER is set: ring the contractor (20s timeout).
//       The <Dial action> points to /missed-call so Twilio falls through to
//       voicemail if the call goes unanswered.
//   3b. If no contractor phone configured: go straight to voicemail greeting.
// ---------------------------------------------------------------------------
router.post('/voice', express.urlencoded({ extended: true }), (req, res) => {
  const { From, CallSid } = req.body;
  const twiml = new VoiceResponse();

  const classification = classifyIncomingCall(From);
  logCall(From, CallSid, classification);
  console.log(`[Twilio] Incoming call from ${From || 'unknown'} — classified as: ${classification}`);

  const baseUrl = process.env.TWILIO_BASE_URL;
  const contractorPhone = process.env.CONTRACTOR_PHONE_NUMBER;

  if (!baseUrl) {
    console.error('[Twilio] TWILIO_BASE_URL not set — cannot build callback URLs');
    twiml.say('Sorry, there is a configuration error. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  twiml.say({ voice: 'alice' }, 'This call may be recorded for quality purposes.');

  // PRIMARY: ring the in-app Voice SDK client (browser softphone).
  // FALLBACK: if CONTRACTOR_PHONE_NUMBER is also set, ring it simultaneously so calls
  //           can still be answered on a personal phone when the app isn't open.
  // Either way, /missed-call handles voicemail if nothing answers before timeout.
  const dial = twiml.dial({
    ...(From && { callerId: From }),
    timeout: 20,
    action: `${baseUrl}/api/twilio/missed-call`,
    method: 'POST',
    record: 'record-from-answer',
    recordingStatusCallback: `${baseUrl}/api/twilio/recording`,
    recordingStatusCallbackMethod: 'POST',
  });

  // Browser client — always included
  dial.client('contractor');

  // PSTN fallback — only if still configured (optional, secondary)
  if (contractorPhone) {
    // answerOnBridge: true prevents carrier voicemail from "answering" the PSTN leg
    dial.number({ answerOnBridge: true }, contractorPhone);
  }

  res.type('text/xml').send(twiml.toString());
});

// ---------------------------------------------------------------------------
// POST /api/twilio/missed-call
// Called by Twilio after a <Dial> completes without being answered.
// DialCallStatus values: completed (answered), no-answer, busy, failed, canceled
// Only 'completed' means the contractor picked up — everything else falls
// through to voicemail.
// ---------------------------------------------------------------------------
router.post('/missed-call', express.urlencoded({ extended: true }), (req, res) => {
  const { DialCallStatus } = req.body;
  const twiml = new VoiceResponse();

  if (DialCallStatus === 'completed') {
    // Contractor answered — call is done, no voicemail needed
    return res.type('text/xml').send(twiml.toString());
  }

  const baseUrl = process.env.TWILIO_BASE_URL;
  if (!baseUrl) {
    console.error('[Twilio] TWILIO_BASE_URL not set — cannot build voicemail action URL');
    twiml.say('Sorry, we are unable to take a message right now. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`[Twilio] Call unanswered (DialCallStatus: ${DialCallStatus}) — routing to voicemail`);
  buildVoicemailTwiml(twiml, baseUrl);
  res.type('text/xml').send(twiml.toString());
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
      phoneNumber: From || null,
      source: 'sms'
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
      phoneNumber: From || null,
      recordingUrl: RecordingUrl || null,
    });

    console.log(`[Twilio] Voicemail lead created from ${From || 'unknown'} — recording stored: ${RecordingUrl ? 'yes' : 'no'}`);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    console.error('[Twilio] Voicemail lead creation failed:', err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/twilio/recording
// Twilio fires this when a recorded answered call is ready.
// Downloads the audio, transcribes it, generates call notes, stores on the
// calls row so it appears in the contact history.
// ---------------------------------------------------------------------------
router.post('/recording', express.urlencoded({ extended: true }), async (req, res) => {
  // Respond immediately — processing happens async
  res.status(204).send();

  const { CallSid, RecordingUrl, RecordingDuration } = req.body;

  if (!RecordingUrl) {
    console.error('[Twilio] /recording webhook: missing RecordingUrl');
    return;
  }

  console.log(`[Twilio] Answered-call recording ready. CallSid: ${CallSid}, URL: ${RecordingUrl}`);

  // Look up the original call to get the caller's number
  const callRow = db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(CallSid);
  const fromNumber = callRow?.from_number || null;

  const tempPath = path.join(os.tmpdir(), `twilio-call-${Date.now()}.mp3`);

  try {
    await downloadToTemp(RecordingUrl, tempPath);

    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tempPath),
    });

    fs.unlinkSync(tempPath);

    const transcript = transcription.text?.trim();

    if (!transcript) {
      console.error('[Twilio] call-recording: transcription returned empty text');
      return;
    }

    // Generate call notes using GPT
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a note-taker for a contractor. You will receive a transcript of a phone call between the contractor and a customer or contact.
Return a JSON object with exactly these fields:
- "summary": string — one concise sentence describing what was discussed and any agreed next steps. Format: "[Caller name] – [what happened]". Keep it factual and brief.
- "keyPoints": array of strings — up to 3 short bullet points a contractor needs to remember: job location, type of work, next step or deadline. Skip anything obvious from the summary. Do not mention contact info.`
        },
        {
          role: 'user',
          content: `Transcribe call notes from this conversation:\n\n${transcript}`
        }
      ]
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const summary = parsed.summary || '';
    const keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 3) : [];

    // Update the existing calls row if we found it, otherwise insert a new one
    if (callRow) {
      db.prepare(
        'UPDATE calls SET recording_url = ?, duration = ?, transcript = ?, summary = ?, key_points = ? WHERE call_sid = ?'
      ).run(RecordingUrl, parseInt(RecordingDuration) || null, transcript, summary, JSON.stringify(keyPoints), CallSid);
    } else {
      db.prepare(
        'INSERT INTO calls (from_number, call_sid, classification, recording_url, duration, transcript, summary, key_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(fromNumber, CallSid, 'Unknown', RecordingUrl, parseInt(RecordingDuration) || null, transcript, summary, JSON.stringify(keyPoints));
    }

    console.log(`[Twilio] Call notes saved for CallSid ${CallSid} (from: ${fromNumber || 'unknown'})`);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    console.error('[Twilio] /recording processing failed:', err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/twilio/voice-client
// TwiML App webhook — Twilio calls this URL when the browser Voice SDK places
// an outbound call via device.connect({ params: { To: '+1...' } }).
// The `To` param is the customer's phone number.
// Records the answered leg via the existing /recording webhook.
// ---------------------------------------------------------------------------
router.post('/voice-client', express.urlencoded({ extended: true }), (req, res) => {
  const { To, CallSid } = req.body;
  const twiml = new VoiceResponse();
  const baseUrl = process.env.TWILIO_BASE_URL;
  const callerId = process.env.TWILIO_PHONE_NUMBER;

  if (!To) {
    console.error('[Twilio] /voice-client: missing To param');
    twiml.say('No destination number provided.');
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`[Twilio] /voice-client: outbound to ${To} (CallSid: ${CallSid})`);
  // Log as Outbound — no recording/transcription for outbound calls (inbound only).
  // Future: add a post-call note flow here once ready.
  logCall(To, CallSid, 'Outbound');

  const dial = twiml.dial({
    ...(callerId && { callerId }),
    // Outbound calls are NOT recorded or transcribed.
    // Inbound calls go through /voice → /recording for that pipeline.
  });
  dial.number(To);

  res.type('text/xml').send(twiml.toString());
});

// ---------------------------------------------------------------------------
// POST /api/twilio/outbound  (LEGACY — click-to-call bridge, kept for reference)
// Initiates a click-to-call from the app:
//   1. Twilio calls CONTRACTOR_PHONE_NUMBER (the user's own phone)
//   2. When they answer, /outbound-bridge TwiML dials the target customer
//   3. The answered leg is recorded → /recording saves call notes
// Body: { to: string }  (customer's phone number)
// ---------------------------------------------------------------------------
router.post('/outbound', express.json(), async (req, res) => {
  const { to } = req.body;
  if (!to || !to.trim()) {
    return res.status(400).json({ error: '"to" phone number is required' });
  }

  const baseUrl = process.env.TWILIO_BASE_URL;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const contractorPhone = process.env.CONTRACTOR_PHONE_NUMBER;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!baseUrl || !fromNumber || !contractorPhone || !accountSid || !authToken) {
    console.error('[Twilio] /outbound: missing required env vars');
    return res.status(500).json({ error: 'Twilio is not fully configured' });
  }

  // Normalize to E.164 — strip formatting, prepend +1 for 10-digit US numbers
  const digits = to.replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === '1' ? `+${digits}` : to.trim();

  console.log(`[Twilio] /outbound: contractor=${contractorPhone} → customer=${e164}`);

  try {
    const client = twilio(accountSid, authToken);

    // Twilio calls the contractor first. When they answer, outbound-bridge dials the customer.
    const call = await client.calls.create({
      from: fromNumber,
      to: contractorPhone,
      url: `${baseUrl}/api/twilio/outbound-bridge?customer=${encodeURIComponent(e164)}`,
      method: 'POST',
    });

    // Log the outbound attempt so it appears in the call timeline
    logCall(contractorPhone, call.sid, 'Outbound');
    console.log(`[Twilio] /outbound: call initiated — SID ${call.sid}, status ${call.status}`);

    return res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    console.error('[Twilio] /outbound: call failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/twilio/outbound-bridge
// TwiML served to the contractor's phone after they answer the outbound leg.
// Dials the customer and records the conversation.
// Query param: customer (E.164 number)
// ---------------------------------------------------------------------------
router.post('/outbound-bridge', express.urlencoded({ extended: true }), (req, res) => {
  const customer = req.query.customer;
  const twiml = new VoiceResponse();
  const baseUrl = process.env.TWILIO_BASE_URL;

  if (!customer) {
    console.error('[Twilio] /outbound-bridge: missing customer param');
    twiml.say('No customer number was specified. Goodbye.');
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`[Twilio] /outbound-bridge: bridging to ${customer}`);
  twiml.say({ voice: 'alice' }, 'Connecting your call.');
  const dial = twiml.dial({
    record: 'record-from-answer',
    ...(baseUrl && {
      recordingStatusCallback: `${baseUrl}/api/twilio/recording`,
      recordingStatusCallbackMethod: 'POST',
    }),
  });
  dial.number(customer);

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
