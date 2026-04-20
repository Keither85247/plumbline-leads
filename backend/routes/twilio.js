const express = require('express');
const router = express.Router();
const log = require('../logger').for('Twilio');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const db = require('../db');
const { createLeadFromTranscript, isDuplicate, hasLeadToday } = require('./leads');
const { sendPush } = require('../services/pushService');
const { DEFAULT_GREETING } = require('./settings');
const { getDataDir } = require('../utils/dataDir');

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
    log.error('Failed to log call to DB', { err: err.message });
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
    log.info(`Recording download attempt ${attempt}/${MAX_ATTEMPTS}`, { url: audioUrl });
    try {
      await attemptDownload(audioUrl, destPath);
      log.info(`Recording download succeeded`, { attempt });
      return destPath;
    } catch (err) {
      lastError = err;
      log.warn(`Recording download attempt ${attempt} failed`, { err: err.message });
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  log.error(`All ${MAX_ATTEMPTS} download attempts failed`, { err: lastError.message });
  throw lastError;
}

// ---------------------------------------------------------------------------
// GET /api/twilio/voicemail-audio
// Serves the custom voicemail greeting audio file publicly so Twilio's
// <Play> verb can fetch it during call handling (no auth required).
// Handles Range requests — Twilio probes files with range headers before
// full playback, and will abort silently if range requests aren't honoured.
// ---------------------------------------------------------------------------
const AUDIO_MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };

router.get('/voicemail-audio', (req, res) => {
  const filename = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting_file'").get()?.value;
  if (!filename) return res.status(404).json({ error: 'No custom greeting on file' });

  const filepath = path.join(getDataDir(), filename);
  let stat;
  try {
    stat = fs.statSync(filepath);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Greeting file not found on disk' });
    throw e;
  }

  const ext         = path.extname(filename).toLowerCase();
  const contentType = AUDIO_MIME[ext] || 'audio/mpeg';
  const total       = stat.size;

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=300');

  const rangeHeader = req.headers['range'];
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10) || 0;
    const end   = parts[1] !== '' ? parseInt(parts[1], 10) : total - 1;
    res.setHeader('Content-Range',  `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    res.status(206);
    fs.createReadStream(filepath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', total);
    fs.createReadStream(filepath).pipe(res);
  }
});

// ---------------------------------------------------------------------------
// Voicemail TwiML helper — appends voicemail verbs onto an existing
// VoiceResponse object. Reused by /voice (no contractor) and /missed-call.
// Plays a custom audio greeting if one has been uploaded; falls back to TTS.
// ---------------------------------------------------------------------------
function buildVoicemailTwiml(twiml, baseUrl) {
  const type     = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting_type'").get()?.value;
  const filename = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting_file'").get()?.value;

  let usedAudio = false;
  if (type === 'audio' && filename) {
    const filepath = path.join(getDataDir(), filename);
    try {
      fs.statSync(filepath); // throws ENOENT if missing
      twiml.play(`${baseUrl}/api/twilio/voicemail-audio`);
      usedAudio = true;
    } catch {}
  }

  if (!usedAudio) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting'").get();
    twiml.say(row?.value || DEFAULT_GREETING);
  }

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
  log.info('Incoming call', { from: From || 'unknown', callSid: CallSid, classification });

  // Push notification — fires immediately so the contractor can open the app
  // and answer before the 20s ring timeout sends the call to voicemail.
  if (classification !== 'Likely Spam') {
    const callerLabel = From
      ? From.replace(/^\+1/, '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')
      : 'Unknown number';
    sendPush(null, {
      title: '📞 Incoming Call',
      body:  `${callerLabel} is calling — open the app to answer`,
      tag:   'incoming-call',
      url:   '/',
    }).catch(() => {});
  }

  const baseUrl = process.env.TWILIO_BASE_URL;

  if (!baseUrl) {
    log.error('TWILIO_BASE_URL not set — cannot build callback URLs');
    twiml.say('Sorry, there is a configuration error. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  twiml.say({ voice: 'alice' }, 'This call may be recorded for quality purposes.');

  // Ring the in-app Voice SDK client (browser softphone) only.
  // /missed-call handles voicemail if nothing answers before timeout.
  const dial = twiml.dial({
    ...(From && { callerId: From }),
    timeout: 20,
    action: `${baseUrl}/api/twilio/missed-call`,
    method: 'POST',
    record: 'record-from-answer',
    recordingStatusCallback: `${baseUrl}/api/twilio/recording`,
    recordingStatusCallbackMethod: 'POST',
  });

  dial.client('contractor');

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
    log.error('TWILIO_BASE_URL not set — cannot build voicemail action URL');
    twiml.say('Sorry, we are unable to take a message right now. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  log.info('Call unanswered — routing to voicemail', { dialCallStatus: DialCallStatus });
  buildVoicemailTwiml(twiml, baseUrl);
  res.type('text/xml').send(twiml.toString());
});

// ---------------------------------------------------------------------------
// POST /api/twilio/sms
// ---------------------------------------------------------------------------
router.post('/sms', express.urlencoded({ extended: true }), async (req, res) => {
  const { From, Body } = req.body;
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  // Drop messages that have neither text nor media
  if (!Body?.trim() && numMedia === 0) {
    return res.status(200).send('OK');
  }

  // Collect inbound MMS media URLs (Twilio sends MediaUrl0, MediaUrl1, …)
  const inboundMediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    const url = req.body[`MediaUrl${i}`];
    if (url) inboundMediaUrls.push(url);
  }
  const mediaUrlsJson = inboundMediaUrls.length > 0 ? JSON.stringify(inboundMediaUrls) : null;

  log.info('Inbound SMS', { from: From, chars: (Body || '').length, mediaCount: numMedia });

  // Always persist the inbound message FIRST so it appears in the inbox
  // regardless of lead creation logic below.
  let messageRowId = null;
  try {
    const msgRow = db.prepare(
      "INSERT INTO messages (phone, direction, body, status, media_urls) VALUES (?, 'inbound', ?, 'received', ?)"
    ).run(From || 'unknown', (Body || '').trim(), mediaUrlsJson);
    messageRowId = msgRow.lastInsertRowid;
    log.info('Inbound SMS saved to messages', { messageId: messageRowId });
  } catch (err) {
    log.error('Failed to save inbound SMS to messages table', { err: err.message });
  }

  // If this phone already has an open lead today, attach the message to it
  // instead of creating a duplicate lead card.
  const existingLead = From
    ? db.prepare(
        `SELECT id FROM leads
         WHERE (phone_number = ? OR callback_number = ?)
           AND archived = 0
         ORDER BY created_at DESC LIMIT 1`
      ).get(From, From)
    : null;

  if (existingLead) {
    if (messageRowId) {
      try {
        db.prepare('UPDATE messages SET lead_id = ? WHERE id = ?')
          .run(existingLead.id, messageRowId);
      } catch (err) {
        log.error('Failed to stamp lead_id on message', { err: err.message });
      }
    }
    if (isDuplicate(From, Body) || hasLeadToday(From)) {
      log.info('SMS attached to existing lead, skipping new lead creation', { from: From, leadId: existingLead.id });
      return res.status(200).send('OK');
    }
  }

  if (isDuplicate(From, Body)) {
    log.info('SMS duplicate detected, skipping lead creation', { from: From });
    return res.status(200).send('OK');
  }

  try {
    const newLead = await createLeadFromTranscript({
      transcript: Body,
      rawText: Body,
      contactNameFallback: From || 'Unknown',
      phoneNumber: From || null,
      source: 'sms'
    });
    // Stamp newly-created lead on the message row
    if (messageRowId && newLead?.id) {
      db.prepare('UPDATE messages SET lead_id = ? WHERE id = ?').run(newLead.id, messageRowId);
    }
  } catch (err) {
    log.error('SMS lead creation failed', { from: From, err: err.message });
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
    log.error('Voicemail webhook: missing RecordingUrl', { from: From });
    return;
  }

  log.info('Voicemail received', { from: From || 'unknown', recordingUrl: RecordingUrl });

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
      log.error('Voicemail transcription returned empty text', { from: From });
      return;
    }

    if (isDuplicate(From, transcript)) {
      log.info('Voicemail duplicate detected, skipping', { from: From });
      return;
    }

    // Associate the lead with the owner account. Twilio webhooks have no user
    // session, so we look up the first user in the DB. In this single-contractor
    // app there is exactly one real account.
    const ownerRow = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    const userId   = ownerRow?.id ?? null;

    const newLead = await createLeadFromTranscript({
      transcript,
      rawText: transcript,
      contactNameFallback: From || 'Unknown',
      phoneNumber: From || null,
      recordingUrl: RecordingUrl || null,
      userId,
    });

    log.info('Voicemail lead created', { from: From || 'unknown', hasRecording: !!RecordingUrl, userId });

    // Push notification — voicemail is fully processed now (transcript + summary ready)
    const vmTitle = newLead?.contact_name && newLead.contact_name !== 'Unknown'
      ? `🎙️ Voicemail from ${newLead.contact_name}`
      : '🎙️ New Voicemail';
    sendPush(userId, {
      title: vmTitle,
      body:  newLead?.summary || 'Tap to listen',
      tag:   `voicemail-${newLead?.id || Date.now()}`,
      url:   '/?tab=calls&subtab=Voicemail',
    }).catch(() => {});
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    log.error('Voicemail lead creation failed', { from: From, err: err.message, stack: err.stack });
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
    log.error('/recording webhook: missing RecordingUrl', { callSid: CallSid });
    return;
  }

  log.info('Answered-call recording ready', { callSid: CallSid, recordingUrl: RecordingUrl, duration: RecordingDuration });

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
      log.error('Call recording transcription returned empty text', { callSid: CallSid });
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

    log.info('Call notes saved', { callSid: CallSid, from: fromNumber || 'unknown', summaryLen: summary.length });
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    log.error('/recording processing failed', { callSid: CallSid, err: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/twilio/diag
// Diagnostic endpoint — verifies the full call-flow configuration without
// placing an actual call. Hit this in a browser to see exactly what is wrong.
// ---------------------------------------------------------------------------
router.get('/diag', async (req, res) => {
  const accountSid      = process.env.TWILIO_ACCOUNT_SID;
  const authToken       = process.env.TWILIO_AUTH_TOKEN;
  const apiKeySid       = process.env.TWILIO_API_KEY_SID   || process.env.TWILIO_API_KEY;
  const apiKeySecret    = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_API_SECRET;
  const twimlAppSid     = process.env.TWILIO_TWIML_APP_SID;
  const phoneNumber     = process.env.TWILIO_PHONE_NUMBER;
  const baseUrl         = process.env.TWILIO_BASE_URL;

  const envCheck = {
    TWILIO_ACCOUNT_SID:   accountSid  ? '✓ set' : '✗ MISSING',
    TWILIO_AUTH_TOKEN:    authToken   ? '✓ set' : '✗ MISSING',
    TWILIO_API_KEY_SID:   apiKeySid   ? '✓ set' : '✗ MISSING',
    TWILIO_API_KEY_SECRET:apiKeySecret? '✓ set' : '✗ MISSING',
    TWILIO_TWIML_APP_SID: twimlAppSid ? `✓ ${twimlAppSid}` : '✗ MISSING',
    TWILIO_PHONE_NUMBER:  phoneNumber ? `✓ ${phoneNumber}` : '✗ MISSING — calls will fail (no callerId)',
    TWILIO_BASE_URL:      baseUrl     ? `✓ ${baseUrl}`     : '✗ MISSING',
  };

  const expectedVoiceUrl = baseUrl ? `${baseUrl}/api/twilio/voice-client` : '(TWILIO_BASE_URL not set)';

  if (!accountSid || !authToken || !twimlAppSid) {
    return res.json({ envCheck, twimlApp: null, expectedVoiceUrl, diagnosis: 'Cannot query Twilio — missing credentials or TwiML App SID' });
  }

  try {
    const client = twilio(accountSid, authToken);
    const app = await client.applications(twimlAppSid).fetch();

    const voiceUrlMatch = app.voiceUrl === expectedVoiceUrl;
    const voiceMethodOk = !app.voiceMethod || app.voiceMethod.toUpperCase() === 'POST';

    return res.json({
      envCheck,
      twimlApp: {
        sid:          app.sid,
        friendlyName: app.friendlyName,
        voiceUrl:     app.voiceUrl     || '(BLANK — THIS IS THE BUG)',
        voiceMethod:  app.voiceMethod  || 'POST (default)',
      },
      expectedVoiceUrl,
      voiceUrlMatch,
      voiceMethodOk,
      diagnosis: !app.voiceUrl
        ? 'BUG: TwiML App Voice URL is blank. Set it to: ' + expectedVoiceUrl
        : !voiceUrlMatch
          ? 'BUG: TwiML App Voice URL mismatch. Expected: ' + expectedVoiceUrl + ' — Got: ' + app.voiceUrl
          : !phoneNumber
            ? 'WARNING: TWILIO_PHONE_NUMBER missing — outbound calls may fail (no callerId)'
            : 'Configuration looks correct. If calls still fail, check Render logs for /voice-client.',
    });
  } catch (err) {
    return res.json({
      envCheck,
      twimlApp: null,
      expectedVoiceUrl,
      diagnosis: `Twilio API error: ${err.message} — TWILIO_TWIML_APP_SID may be wrong or TWILIO_AUTH_TOKEN may be invalid`,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/twilio/voice-client
// TwiML App webhook — Twilio calls this URL when the browser Voice SDK places
// an outbound call via device.connect({ params: { To: '+1...' } }).
//
// Routing logic:
//   • If To starts with 'client:' → route to that Twilio Client identity (browser)
//   • Otherwise              → treat To as a PSTN phone number and dial it
//
// The browser stays the audio endpoint in both cases.
// Records the answered leg via the existing /recording webhook.
// ---------------------------------------------------------------------------
router.post('/voice-client', express.urlencoded({ extended: true }), (req, res) => {
  const { To, CallSid } = req.body;
  log.info('/voice-client received', { to: To, callSid: CallSid });

  const twiml = new VoiceResponse();
  const baseUrl = process.env.TWILIO_BASE_URL;
  const callerId = process.env.TWILIO_PHONE_NUMBER;

  try {
    if (!To) {
      log.error('/voice-client: missing To param', { callSid: CallSid });
      twiml.say('No destination number provided.');
      return res.type('text/xml').send(twiml.toString());
    }

    const isClient = To.startsWith('client:');
    const destination = isClient ? To.replace(/^client:/, '') : To;

    if (isClient) {
      log.info('/voice-client routing to browser client', { destination, callSid: CallSid });
    } else {
      log.info('/voice-client dialing PSTN', { to: To, callSid: CallSid });
    }

    logCall(To, CallSid, 'Outbound');

    const dial = twiml.dial({
      ...(callerId && !isClient && { callerId }),
      record: 'record-from-answer',
      ...(baseUrl && {
        recordingStatusCallback:       `${baseUrl}/api/twilio/recording`,
        recordingStatusCallbackMethod: 'POST',
      }),
    });

    if (isClient) {
      dial.client(destination);
    } else {
      dial.number(To);
    }

    log.info('/voice-client responding with TwiML', { callerId: callerId || 'none', hasBaseUrl: !!baseUrl });
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    log.error('/voice-client unhandled error', { err: err.message, callSid: CallSid });
    // Always return valid TwiML — a 500 here causes Twilio SDK error 31000
    const errTwiml = new VoiceResponse();
    errTwiml.say('An error occurred while connecting your call. Please try again.');
    return res.type('text/xml').send(errTwiml.toString());
  }
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
    log.error('/outbound: missing required env vars', { hasBaseUrl: !!baseUrl, hasFrom: !!fromNumber, hasContractor: !!contractorPhone });
    return res.status(500).json({ error: 'Twilio is not fully configured' });
  }

  // Normalize to E.164 — strip formatting, prepend +1 for 10-digit US numbers
  const digits = to.replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === '1' ? `+${digits}` : to.trim();

  log.info('/outbound: initiating call', { contractor: contractorPhone, customer: e164 });

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
    log.info('/outbound: call initiated', { sid: call.sid, status: call.status });

    return res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    log.error('/outbound: call failed', { err: err.message, to: e164 });
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/twilio/outbound-bridge
// Legacy: TwiML served after the contractor's personal phone answers.
// Updated to route back to the browser client (identity: 'contractor') instead
// of dialing a PSTN number, so all audio stays inside the app.
// Query param: customer (E.164 number — kept for logging/context only)
// ---------------------------------------------------------------------------
router.post('/outbound-bridge', express.urlencoded({ extended: true }), (req, res) => {
  const customer = req.query.customer;
  const twiml = new VoiceResponse();
  const baseUrl = process.env.TWILIO_BASE_URL;

  if (!customer) {
    log.error('/outbound-bridge: missing customer param');
    twiml.say('No customer number was specified. Goodbye.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Route to the browser client, not a PSTN number.
  // 'contractor' must match the identity issued by /api/twilio/token.
  log.info('/outbound-bridge: routing to browser client', { customer });
  twiml.say({ voice: 'alice' }, 'Connecting your call.');
  const dial = twiml.dial({
    record: 'record-from-answer',
    ...(baseUrl && {
      recordingStatusCallback: `${baseUrl}/api/twilio/recording`,
      recordingStatusCallbackMethod: 'POST',
    }),
  });
  dial.client('contractor'); // browser softphone — NOT a PSTN number

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
