const express = require('express');
const router = express.Router();
const log = require('../logger').for('Twilio');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const db = require('../db');
const { createLeadFromTranscript, isDuplicate, hasLeadToday } = require('./leads');
const { sendPush } = require('../services/pushService');
const { DEFAULT_GREETING, userGreetingDir, getGreetingRow } = require('./settings');
const { getDataDir } = require('../utils/dataDir');
const verifyTwilioSignature = require('../middleware/verifyTwilioSignature');
const requireAuth = require('../middleware/requireAuth');
const requireOwner = require('../middleware/requireOwner');
const { resolveSafeRecordingUrl } = require('../utils/twilioRecording');
const { isAccountActive } = require('../utils/accountStatus');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Caller classification
// Uses prior lead history to classify an incoming number before routing.
// ---------------------------------------------------------------------------
function classifyIncomingCall(fromNumber, userId) {
  // Anonymous / blocked caller
  if (!fromNumber || fromNumber === 'anonymous' || fromNumber === 'blocked') {
    return 'Likely Spam';
  }

  // Look up all prior leads associated with this number
  const priorLeads = db.prepare(
    `SELECT category FROM leads
     WHERE (phone_number = ? OR callback_number = ?)
       AND user_id = ?`
  ).all(fromNumber, fromNumber, userId || null);

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

// ---------------------------------------------------------------------------
// Routing helpers — map an incoming Twilio number to the user who owns it.
// Falls back to the owner account if the number isn't in the DB.
// ---------------------------------------------------------------------------
function getOwnerUserId() {
  return (
    db.prepare('SELECT id FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1').get()?.id ??
    db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id ??
    null
  );
}

// Suspended / blocked receiving accounts: Twilio still gets a valid 200
// response (so it does not retry), but nothing is created, altered, notified or
// sent to paid AI, and the event is NOT re-routed to any other account.
// Voice is rejected before it is answered (caller hears busy; no answer charge).
function refuseInboundVoice(res, twiml, callSid) {
  log.warn('Inbound call refused — receiving account not active', { callSid });
  twiml.reject({ reason: 'busy' });
  return res.type('text/xml').send(twiml.toString());
}

function getAssignedUserForNumber(toNumber) {
  if (toNumber) {
    const row = db.prepare(
      'SELECT assigned_user_id FROM phone_numbers WHERE phone_number = ?'
    ).get(toNumber);
    if (row?.assigned_user_id) return row.assigned_user_id;
  }
  return getOwnerUserId();
}

// Log an inbound or outbound call to the calls table.
// Idempotent on call_sid: if a row already exists for this Twilio CallSid
// (e.g. the user's POST /outbound-note raced ahead of this webhook and
// inserted a fallback row), enrich the existing row's NULL fields instead of
// creating a duplicate. The partial UNIQUE INDEX on call_sid is the safety net.
function logCall(fromNumber, callSid, classification, userId) {
  try {
    if (callSid) {
      const existing = db.prepare('SELECT id FROM calls WHERE call_sid = ?').get(callSid);
      if (existing) {
        db.prepare(`
          UPDATE calls SET
            from_number    = COALESCE(from_number, ?),
            classification = CASE WHEN classification = 'Unknown' THEN ? ELSE classification END,
            user_id        = COALESCE(user_id, ?)
          WHERE id = ?
        `).run(fromNumber || null, classification, userId || null, existing.id);
        return;
      }
    }
    db.prepare(
      'INSERT INTO calls (from_number, call_sid, classification, user_id) VALUES (?, ?, ?, ?)'
    ).run(fromNumber || null, callSid || null, classification, userId || null);
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

// `safeUrl` MUST already have passed resolveSafeRecordingUrl — this function
// attaches Twilio Basic credentials, so it must only ever be handed a URL
// proven to point at api.twilio.com for the configured account. We assert https
// as a second belt: the validator guarantees it, and node's http/https .get
// does NOT follow redirects, so credentials can never be re-sent to a 3xx
// Location target (a non-200/redirect is simply treated as a failed attempt).
function attemptDownload(safeUrl, destPath) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return Promise.reject(new Error('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not set in .env'));
  }
  if (!safeUrl.startsWith('https://')) {
    return Promise.reject(new Error('refusing to attach credentials to non-https url'));
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const options = { headers: { Authorization: `Basic ${credentials}` } };

    https.get(safeUrl, options, (res) => {
      if (res.statusCode !== 200) {
        // Includes 3xx redirects — we never follow them, so credentials are
        // never forwarded to a redirect target.
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
// `safeUrl` is the validated .mp3 media URL from resolveSafeRecordingUrl.
async function downloadToTemp(safeUrl, destPath) {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 2000;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log.info(`Recording download attempt ${attempt}/${MAX_ATTEMPTS}`, { url: safeUrl });
    try {
      await attemptDownload(safeUrl, destPath);
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
// GET /api/twilio/voicemail-audio?t=TOKEN
// Public endpoint used by Twilio's <Play> verb during call handling. The token
// is a per-user random hex string stored in voicemail_greetings.public_token —
// it is the ONLY way to access a greeting file. No user_id appears in the URL.
// Tokens rotate on every upload so leaked URLs die when the user re-records.
// Handles Range requests — Twilio probes files with range headers before full
// playback, and will abort silently if range requests aren't honoured.
// ---------------------------------------------------------------------------
const AUDIO_MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };

router.get('/voicemail-audio', (req, res) => {
  const token = req.query.t;
  if (!token || typeof token !== 'string' || !/^[a-f0-9]{32,128}$/i.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const row = db.prepare(`
    SELECT user_id, audio_file
    FROM voicemail_greetings
    WHERE public_token = ? AND type = 'audio' AND audio_file IS NOT NULL
  `).get(token);

  if (!row) return res.status(404).json({ error: 'Not found' });

  // Resolve the file path strictly inside the owning user's directory and
  // verify the resolved path is still inside that directory — defence in depth
  // against any future filename ever containing path-traversal characters.
  const userDir  = path.resolve(userGreetingDir(row.user_id));
  const filepath = path.resolve(userDir, row.audio_file);
  if (!filepath.startsWith(userDir + path.sep)) {
    log.warn('Voicemail audio request rejected — path escaped user dir', { tokenPrefix: token.slice(0, 8) });
    return res.status(404).json({ error: 'Not found' });
  }

  let stat;
  try {
    stat = fs.statSync(filepath);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Greeting file not found on disk' });
    throw e;
  }

  const ext         = path.extname(row.audio_file).toLowerCase();
  const contentType = AUDIO_MIME[ext] || 'audio/mpeg';
  const total       = stat.size;

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  // Private cache only — tokens rotate, never let an intermediary share them
  res.setHeader('Cache-Control', 'private, max-age=300');

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
// Plays the ASSIGNED USER's custom audio greeting if one is uploaded; falls
// back to the assigned user's TTS text; falls back to a generic default. Never
// reads from any other user's greeting under any condition.
// ---------------------------------------------------------------------------
function buildVoicemailTwiml(twiml, baseUrl, userId) {
  const row = userId ? getGreetingRow(userId) : null;

  let usedAudio = false;
  if (row && row.type === 'audio' && row.audio_file && row.public_token) {
    const userDir  = path.resolve(userGreetingDir(userId));
    const filepath = path.resolve(userDir, row.audio_file);
    if (filepath.startsWith(userDir + path.sep)) {
      try {
        fs.statSync(filepath); // throws ENOENT if missing
        twiml.play(`${baseUrl}/api/twilio/voicemail-audio?t=${row.public_token}`);
        usedAudio = true;
      } catch (err) {
        log.warn('Voicemail audio file missing for user', { userId, err: err.message });
      }
    }
  }

  if (!usedAudio) {
    twiml.say((row?.tts_text || '').trim() || DEFAULT_GREETING);
  }

  const vmAction = userId
    ? `${baseUrl}/api/twilio/voicemail?user_id=${userId}`
    : `${baseUrl}/api/twilio/voicemail`;
  twiml.record({
    action:      vmAction,
    method:      'POST',
    maxLength:   120,
    playBeep:    true,
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
router.post('/voice', express.urlencoded({ extended: true }), verifyTwilioSignature, (req, res) => {
  const { From, To, Called, CallSid } = req.body;
  const twiml = new VoiceResponse();

  // Determine which user owns the number that was called
  const toNumber       = To || Called;
  const assignedUserId = getAssignedUserForNumber(toNumber);

  if (!isAccountActive(assignedUserId)) return refuseInboundVoice(res, twiml, CallSid);

  const classification = classifyIncomingCall(From, assignedUserId);
  logCall(From, CallSid, classification, assignedUserId);
  log.info('Incoming call', { from: From || 'unknown', to: toNumber, callSid: CallSid, classification, assignedUserId });

  // Push only to the user who owns this number
  if (classification !== 'Likely Spam') {
    const callerLabel = From
      ? From.replace(/^\+1/, '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')
      : 'Unknown number';
    sendPush(assignedUserId, {
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

  // Ring the assigned user's in-app Voice SDK client.
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

  dial.client(`user_${assignedUserId}`);

  res.type('text/xml').send(twiml.toString());
});

// ---------------------------------------------------------------------------
// POST /api/twilio/missed-call
// Called by Twilio after a <Dial> completes without being answered.
// DialCallStatus values: completed (answered), no-answer, busy, failed, canceled
// Only 'completed' means the contractor picked up — everything else falls
// through to voicemail.
// ---------------------------------------------------------------------------
router.post('/missed-call', express.urlencoded({ extended: true }), verifyTwilioSignature, (req, res) => {
  const { DialCallStatus, To, Called } = req.body;
  const twiml = new VoiceResponse();

  if (DialCallStatus === 'completed') {
    return res.type('text/xml').send(twiml.toString());
  }

  const baseUrl = process.env.TWILIO_BASE_URL;
  if (!baseUrl) {
    log.error('TWILIO_BASE_URL not set — cannot build voicemail action URL');
    twiml.say('Sorry, we are unable to take a message right now. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  const toNumber       = To || Called;
  const assignedUserId = getAssignedUserForNumber(toNumber);

  // Account disabled while the call was ringing: no voicemail, no re-routing.
  if (!isAccountActive(assignedUserId)) {
    log.warn('Unanswered call ended — receiving account not active');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  log.info('Call unanswered — routing to voicemail', { dialCallStatus: DialCallStatus, assignedUserId });
  buildVoicemailTwiml(twiml, baseUrl, assignedUserId);
  res.type('text/xml').send(twiml.toString());
});

// ---------------------------------------------------------------------------
// POST /api/twilio/sms
// ---------------------------------------------------------------------------
router.post('/sms', express.urlencoded({ extended: true }), verifyTwilioSignature, async (req, res) => {
  const { From, To, Body } = req.body;
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const assignedUserId = getAssignedUserForNumber(To);

  // Drop messages that have neither text nor media
  if (!Body?.trim() && numMedia === 0) {
    return res.status(200).send('OK');
  }

  // Never store a message or lead without a verified owning account.
  if (!assignedUserId) {
    log.warn('Inbound SMS dropped — no owning account for receiving number', { to: To });
    return res.status(200).send('OK');
  }

  // Receiving account suspended or blocked: acknowledge only. No message, lead,
  // AI analysis or notification, and no re-routing to another account.
  if (!isAccountActive(assignedUserId)) {
    log.warn('Inbound SMS dropped — receiving account not active', { assignedUserId });
    return res.status(200).send('OK');
  }

  // Drop inbound SMS if the receiving number is suspended
  if (To) {
    const numRow = db.prepare(
      'SELECT is_suspended FROM phone_numbers WHERE phone_number = ?'
    ).get(To);
    if (numRow?.is_suspended) {
      log.warn('Inbound SMS dropped — number suspended', { to: To, from: From, assignedUserId });
      return res.status(200).send('OK');
    }
  }

  // Collect inbound MMS media URLs (Twilio sends MediaUrl0, MediaUrl1, …)
  const inboundMediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    const url = req.body[`MediaUrl${i}`];
    if (url) inboundMediaUrls.push(url);
  }
  const mediaUrlsJson = inboundMediaUrls.length > 0 ? JSON.stringify(inboundMediaUrls) : null;

  log.info('Inbound SMS', { from: From, to: To, assignedUserId, chars: (Body || '').length, mediaCount: numMedia });

  // Always persist the inbound message FIRST so it appears in the inbox
  // regardless of lead creation logic below.
  let messageRowId = null;
  try {
    const msgRow = db.prepare(
      "INSERT INTO messages (phone, direction, body, status, media_urls, user_id) VALUES (?, 'inbound', ?, 'received', ?, ?)"
    ).run(From || 'unknown', (Body || '').trim(), mediaUrlsJson, assignedUserId || null);
    messageRowId = msgRow.lastInsertRowid;
    log.info('Inbound SMS saved to messages', { messageId: messageRowId });

    // Auto-restore: an incoming message from a previously-hidden contact
    // un-hides the conversation for the assigned user so they see the new
    // message in their inbox.
    if (assignedUserId && From) {
      db.prepare('DELETE FROM conversation_hides WHERE user_id = ? AND phone = ?')
        .run(assignedUserId, From);
    }
  } catch (err) {
    log.error('Failed to save inbound SMS to messages table', { err: err.message });
  }

  // If this phone already has an open lead today, attach the message to it
  // instead of creating a duplicate lead card.
  const existingLead = From
    ? db.prepare(
        `SELECT id FROM leads
         WHERE (phone_number = ? OR callback_number = ?)
           AND user_id = ?
           AND archived = 0
         ORDER BY created_at DESC LIMIT 1`
      ).get(From, From, assignedUserId || null)
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
    if (isDuplicate(From, Body, assignedUserId || null) || hasLeadToday(From, assignedUserId || null)) {
      log.info('SMS attached to existing lead, skipping new lead creation', { from: From, leadId: existingLead.id });
      return res.status(200).send('OK');
    }
  }

  if (isDuplicate(From, Body, assignedUserId || null)) {
    log.info('SMS duplicate detected, skipping lead creation', { from: From });
    return res.status(200).send('OK');
  }

  try {
    const newLead = await createLeadFromTranscript({
      transcript: Body,
      rawText: Body,
      contactNameFallback: From || 'Unknown',
      phoneNumber: From || null,
      source: 'sms',
      userId: assignedUserId || null,
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
router.post('/voicemail', express.urlencoded({ extended: true }), verifyTwilioSignature, async (req, res) => {
  const { RecordingUrl, RecordingSid, From, CallSid } = req.body;
  // user_id injected by buildVoicemailTwiml into the action URL as a query param
  const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : getOwnerUserId();

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);

  if (!RecordingUrl && !RecordingSid) {
    log.error('Voicemail webhook: missing RecordingUrl/RecordingSid', { from: From });
    return;
  }

  // Never create a lead/call update without a verified owning account.
  if (!Number.isInteger(userId) || userId <= 0) {
    log.error('Voicemail webhook: no owning account — skipped', { callSid: CallSid });
    return;
  }

  // Account disabled since the call started: no download, AI, lead or push.
  if (!isAccountActive(userId)) {
    log.warn('Voicemail webhook: receiving account not active — skipped', { callSid: CallSid });
    return;
  }

  // Derive a credential-safe URL from the trusted RecordingSid (preferred) or
  // strictly validate the supplied URL. Never attach credentials otherwise.
  let safeUrl;
  try {
    safeUrl = resolveSafeRecordingUrl({ recordingSid: RecordingSid, recordingUrl: RecordingUrl });
  } catch (err) {
    log.error('Voicemail webhook: unsafe recording reference rejected', { from: From, reason: err.message });
    return;
  }

  log.info('Voicemail received', { from: From || 'unknown', userId });

  const tempPath = path.join(os.tmpdir(), `twilio-vm-${Date.now()}.mp3`);

  try {
    await downloadToTemp(safeUrl, tempPath);

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

    if (isDuplicate(From, transcript, userId)) {
      log.info('Voicemail duplicate detected, skipping', { from: From });
      return;
    }

    const newLead = await createLeadFromTranscript({
      transcript,
      rawText: transcript,
      contactNameFallback: From || 'Unknown',
      phoneNumber: From || null,
      recordingUrl: safeUrl,      // store the validated canonical Twilio URL
      userId,
      callSid: CallSid || null,   // lets the vendor-routing path enrich the
                                  // originating call row with transcript +
                                  // summary so the voicemail is still fully
                                  // reviewable in Timeline / Contact History
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
router.post('/recording', express.urlencoded({ extended: true }), verifyTwilioSignature, async (req, res) => {
  // Respond immediately — processing happens async
  res.status(204).send();

  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;

  if (!RecordingUrl && !RecordingSid) {
    log.error('/recording webhook: missing RecordingUrl/RecordingSid', { callSid: CallSid });
    return;
  }

  // Derive a credential-safe URL from the trusted RecordingSid (preferred) or
  // strictly validate the supplied URL. Never attach credentials otherwise.
  let safeUrl;
  try {
    safeUrl = resolveSafeRecordingUrl({ recordingSid: RecordingSid, recordingUrl: RecordingUrl });
  } catch (err) {
    log.error('/recording webhook: unsafe recording reference rejected', { callSid: CallSid, reason: err.message });
    return;
  }

  log.info('Answered-call recording ready', { callSid: CallSid, duration: RecordingDuration });

  // Look up the original call to get the caller's number. The row (created by
  // /voice or /voice-client) carries the owning account; without it there is
  // no verified owner, so skip rather than create an ownerless call row.
  const callRow = db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(CallSid);
  if (!callRow || !callRow.user_id) {
    log.warn('/recording webhook: no owned call row for CallSid — skipped', { callSid: CallSid });
    return;
  }
  // Account disabled since the call started: no download, AI or call update.
  if (!isAccountActive(callRow.user_id)) {
    log.warn('/recording webhook: owning account not active — skipped', { callSid: CallSid });
    return;
  }
  const fromNumber = callRow.from_number || null;

  const tempPath = path.join(os.tmpdir(), `twilio-call-${Date.now()}.mp3`);

  try {
    await downloadToTemp(safeUrl, tempPath);

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

    // Update the owned calls row (verified above)
    db.prepare(
      'UPDATE calls SET recording_url = ?, duration = ?, transcript = ?, summary = ?, key_points = ? WHERE call_sid = ? AND user_id = ?'
    ).run(safeUrl, parseInt(RecordingDuration) || null, transcript, summary, JSON.stringify(keyPoints), CallSid, callRow.user_id);

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
router.get('/diag', requireAuth, requireOwner, async (req, res) => {
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
router.post('/voice-client', express.urlencoded({ extended: true }), verifyTwilioSignature, (req, res) => {
  const { To, From, CallSid } = req.body;
  log.info('/voice-client received', { to: To, from: From, callSid: CallSid });

  const twiml = new VoiceResponse();
  const baseUrl = process.env.TWILIO_BASE_URL;

  // Derive callerId and userId from the Twilio Voice SDK client identity.
  // From is set by the SDK as 'client:user_<id>' — e.g. 'client:user_5'.
  // Extract both so we can (a) pick the right caller-ID number and
  // (b) stamp the call row with the correct user_id so it appears in
  // user-scoped queries (interaction counts, contact history, etc.).
  let callerId    = process.env.TWILIO_PHONE_NUMBER;
  let callerUserId = null;

  if (From && From.startsWith('client:user_')) {
    const uid = parseInt(From.replace('client:user_', ''), 10);
    if (!isNaN(uid)) {
      callerUserId = uid;
      const numRow = db.prepare(
        'SELECT phone_number FROM phone_numbers WHERE assigned_user_id = ? ORDER BY id LIMIT 1'
      ).get(uid);
      if (numRow?.phone_number) callerId = numRow.phone_number;
    }
  }

  // A Voice token issued before a suspension/block stays valid for up to an
  // hour; refuse calls from disabled accounts here as well.
  if (callerUserId && !isAccountActive(callerUserId)) {
    log.warn('/voice-client: caller account not active — call refused', { callSid: CallSid, userId: callerUserId });
    twiml.say('This account is not active.');
    return res.type('text/xml').send(twiml.toString());
  }

  // In-app (client-to-client) calls must not ring a disabled account's device
  // either — this path never passes through /voice. The identity is normalised
  // and only an active account's exact `user_<id>` identity is ever dialled.
  let clientIdentity = null;
  if (typeof To === 'string' && To.startsWith('client:')) {
    const m = /^user_(\d+)$/.exec(To.slice(7).trim());
    if (!m || !isAccountActive(parseInt(m[1], 10))) {
      log.warn('/voice-client: in-app destination not available — call refused', { callSid: CallSid });
      twiml.say('The person you are calling is not available.');
      return res.type('text/xml').send(twiml.toString());
    }
    clientIdentity = `user_${parseInt(m[1], 10)}`;
  }

  try {
    if (!To) {
      log.error('/voice-client: missing To param', { callSid: CallSid });
      twiml.say('No destination number provided.');
      return res.type('text/xml').send(twiml.toString());
    }

    const isClient = !!clientIdentity;
    const destination = isClient ? clientIdentity : To;

    if (isClient) {
      log.info('/voice-client routing to browser client', { destination, callSid: CallSid });
    } else {
      log.info('/voice-client dialing PSTN', { to: To, callSid: CallSid });
    }

    // Log with the correct user_id so the call is visible in user-scoped queries
    // (contact history, interaction counts, etc.).
    logCall(To, CallSid, 'Outbound', callerUserId);
    log.info('/voice-client: outbound call logged', { to: To, callSid: CallSid, userId: callerUserId });

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

    const twimlXml = twiml.toString();
    // Log the full TwiML so we can see exactly what Twilio is being told to
    // do. Helpful when calls die immediately after connect — usually means
    // the dialed verb completed faster than expected (rejected callerId,
    // invalid number, instant remote hangup, etc.).
    log.info('/voice-client responding with TwiML', {
      callSid: CallSid,
      callerId: callerId || 'none',
      hasBaseUrl: !!baseUrl,
      twiml: twimlXml,
    });
    return res.type('text/xml').send(twimlXml);
  } catch (err) {
    log.error('/voice-client unhandled error', { err: err.message, callSid: CallSid });
    // Always return valid TwiML — a 500 here causes Twilio SDK error 31000
    const errTwiml = new VoiceResponse();
    errTwiml.say('An error occurred while connecting your call. Please try again.');
    return res.type('text/xml').send(errTwiml.toString());
  }
});

// ---------------------------------------------------------------------------
// POST /api/twilio/outbound  (RETIRED — DEF-2)
//
// This legacy REST endpoint was publicly mounted (before the global auth
// middleware) and called client.calls.create() using the GLOBAL
// CONTRACTOR_PHONE_NUMBER — i.e. any unauthenticated caller could make the
// server place a paid Twilio call on the business's behalf.
//
// It has NO callers: the app places outbound calls through the Twilio Voice
// SDK (device.connect → the TwiML App voice URL /api/twilio/voice-client),
// never through this route. It is retired with HTTP 410 and NO LONGER calls
// client.calls.create() — there is no code path here that can initiate a call.
// ---------------------------------------------------------------------------
router.post('/outbound', express.json(), (req, res) => {
  log.warn('/outbound: rejected — endpoint retired (DEF-2)');
  return res.status(410).json({
    error: 'This endpoint has been retired. Outbound calls are placed through the in-app Voice SDK.',
  });
});

// ---------------------------------------------------------------------------
// POST /api/twilio/outbound-bridge  (part of the retired /outbound flow)
// Only ever reached from the retired /outbound endpoint above, so it is now
// unreachable in normal operation. Kept and signature-protected so that a
// forged request is rejected (403) rather than served TwiML. Contains no paid
// action (returns TwiML only).
// ---------------------------------------------------------------------------
router.post('/outbound-bridge', express.urlencoded({ extended: true }), verifyTwilioSignature, (req, res) => {
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
