const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const db = require('../db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VALID_STATUSES = ['New', 'Contacted', 'Qualified', 'Closed'];
const VALID_CATEGORIES = ['Lead', 'Existing Customer', 'Vendor', 'Spam', 'Other'];

// Status sort order: New first, Closed last
const STATUS_ORDER = { New: 0, Contacted: 1, Qualified: 2, Closed: 3 };

// Shared logic: call OpenAI, save lead, return the saved row.
// contactNameFallback is used when OpenAI cannot extract a name from the transcript.
// phoneNumber is pre-extracted from inbound caller ID (Twilio From field) when available.
// language: 'en' | 'es' — controls the output language for summary, keyPoints, followUpText.
//   Falls back to the LANGUAGE env var, then 'en'.
async function createLeadFromTranscript({ transcript, rawText, contactNameFallback = 'Unknown', phoneNumber = null, source = 'voicemail', language, recordingUrl = null }) {
  const lang = language || process.env.LANGUAGE || 'en';
  const languageInstruction = lang === 'es'
    ? '\n- IMPORTANT: Write the "summary", all "keyPoints" strings, and "followUpText" in Spanish (Español). Keep all JSON field names in English.'
    : '';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a CRM assistant that analyzes contractor call transcripts and voicemails. Return a JSON object with exactly these fields:
- "contactName": string — the primary contact's full name extracted from the transcript, or "Unknown" if not identifiable
- "companyName": string — the business or organization the caller represents. Only include if explicitly stated or clearly implied (e.g. "from Advanced Paint", "I'm with Roto-Rooter"). Do not guess. Return an empty string if unclear.
- "category": string — classify the caller into exactly one of these values: "Lead" (new job inquiry, estimate request, potential sale), "Existing Customer" (service issue, follow-up, complaint, or existing project), "Vendor" (supplier, partner, subcontractor, or business contact), "Spam" (robocall, irrelevant solicitation, obvious junk), "Other" (unclear or does not fit above). Return only the exact string value.
- "summary": string — a single concise sentence formatted exactly as: "[Caller Name] ([Company Name]) – [what the call was about]". If no company is known, omit the parenthetical entirely and use: "[Caller Name] – [what the call was about]". If the caller name is unknown, start with just the action. Keep it short and factual. Examples: "Gonzo (Advanced Paint) – Called about paint pickup", "Mike – Asked for an estimate on a bathroom remodel", "Called about a broken water heater, no name given"
- "keyPoints": array of strings — up to 3 short, contractor-focused bullet points. Prioritize in this order: (1) job location or address if mentioned, (2) type of work or service requested, (3) urgency, timing, or requested next step. Do NOT include anything about contact info being provided or left — that is already shown on the card. Do NOT repeat what is already obvious from the summary. Every bullet should be new, specific, and actionable information a contractor needs before calling back.
- "callbackNumber": string — if the caller explicitly states a different number to call them back at (e.g. "call me back at 203-555-1234" or "my cell is 555-9876"), extract that number exactly as spoken. If no alternate callback number is mentioned, return an empty string.
- "followUpText": string — a short, natural SMS-style follow-up message a contractor would send to the customer after the call. It should reference the customer's specific request, suggest a next step, sound like a real person texting (not a template), and use no emojis. Use [Your Name] as a placeholder for the contractor's name. Example: "Hi Mike, this is [Your Name]. Got your call about the breaker panel and outdoor lighting. Happy to help. Let me know a good time to connect."${languageInstruction}`
      },
      {
        role: 'user',
        content: `Analyze this call transcript:\n\n${transcript}`
      }
    ]
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  const { contactName = 'Unknown', companyName = '', category = 'Other', summary = '', keyPoints = [], callbackNumber = '', followUpText = '' } = parsed;

  const resolvedName = contactName === 'Unknown' ? contactNameFallback : contactName;
  const resolvedCompany = typeof companyName === 'string' ? companyName.trim() : '';
  const resolvedCategory = VALID_CATEGORIES.includes(category) ? category : 'Other';

  // Prefer the callback number explicitly given in the transcript; fall back to caller ID
  const extractedCallback = typeof callbackNumber === 'string' ? callbackNumber.trim() : '';

  const result = db.prepare(
    'INSERT INTO leads (transcript, raw_text, contact_name, company_name, phone_number, callback_number, summary, key_points, follow_up_text, category, source, recording_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    transcript,
    rawText ?? transcript,
    resolvedName,
    resolvedCompany || null,
    phoneNumber,
    extractedCallback || null,
    summary,
    JSON.stringify(Array.isArray(keyPoints) ? keyPoints.slice(0, 3) : []),
    followUpText,
    resolvedCategory,
    source,
    recordingUrl || null
  );
  console.log(`[Leads] Lead created — id:${result.lastInsertRowid} source:${source} recording:${recordingUrl ? 'yes' : 'none'}`);

  const newLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
  newLead.key_points = JSON.parse(newLead.key_points);
  return newLead;
}

// Check for a duplicate: same phone number + transcript submitted within the last 5 minutes
function isDuplicate(phoneNumber, transcript) {
  if (!phoneNumber) return false;
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const existing = db.prepare(
    'SELECT id FROM leads WHERE phone_number = ? AND transcript = ? AND created_at > ?'
  ).get(phoneNumber, transcript, fiveMinutesAgo);
  return !!existing;
}

// POST /api/leads — accept transcript, summarize via OpenAI, save and return lead
router.post('/', async (req, res) => {
  const { transcript } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: 'Transcript is required' });
  }

  try {
    const newLead = await createLeadFromTranscript({
      transcript,
      rawText: req.body.rawText || transcript,
      language: req.body.language || undefined,
    });
    return res.status(201).json(newLead);
  } catch (err) {
    console.error('Error creating lead:', err);
    if (err?.status === 401) {
      return res.status(502).json({ error: 'Invalid OpenAI API key. Check your .env file.' });
    }
    return res.status(500).json({ error: 'Failed to process transcript. ' + err.message });
  }
});

// GET /api/leads — return leads; ?archived=true returns only archived; ?source=voicemail filters by source
router.get('/', (req, res) => {
  try {
    const showArchived = req.query.archived === 'true';
    const { source } = req.query;

    let query = 'SELECT * FROM leads WHERE archived = ?';
    const params = [showArchived ? 1 : 0];
    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }
    query += ' ORDER BY created_at DESC';

    const leads = db.prepare(query).all(...params);
    const result = leads.map(lead => ({
      ...lead,
      key_points: JSON.parse(lead.key_points)
    }));
    if (!showArchived) {
      result.sort((a, b) => {
        const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
        if (statusDiff !== 0) return statusDiff;
        return new Date(b.created_at) - new Date(a.created_at);
      });
    }
    return res.json(result);
  } catch (err) {
    console.error('Error fetching leads:', err);
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// GET /api/leads/:id/voicemail — proxy voicemail audio from Twilio with Basic auth
// The browser cannot authenticate directly against Twilio recording URLs, so
// this route fetches the audio server-side and streams it to the client.
router.get('/:id/voicemail', (req, res) => {
  const lead = db.prepare('SELECT recording_url FROM leads WHERE id = ?').get(req.params.id);

  if (!lead) {
    console.warn(`[Leads] Voicemail playback: lead ${req.params.id} not found`);
    return res.status(404).json({ error: 'Lead not found' });
  }
  if (!lead.recording_url) {
    console.warn(`[Leads] Voicemail playback: lead ${req.params.id} has no recording_url`);
    return res.status(404).json({ error: 'No recording available for this lead' });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('[Leads] Voicemail playback: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing');
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  const audioUrl = lead.recording_url.endsWith('.mp3')
    ? lead.recording_url
    : `${lead.recording_url}.mp3`;

  console.log(`[Leads] Voicemail playback: proxying lead ${req.params.id} → ${audioUrl}`);

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const protocol = audioUrl.startsWith('https') ? require('https') : require('http');

  protocol.get(audioUrl, { headers: { Authorization: `Basic ${credentials}` } }, (twilioRes) => {
    if (twilioRes.statusCode !== 200) {
      console.error(`[Leads] Voicemail playback: Twilio returned ${twilioRes.statusCode} for lead ${req.params.id}`);
      twilioRes.resume();
      return res.status(502).json({ error: `Twilio returned ${twilioRes.statusCode}` });
    }
    res.setHeader('Content-Type', twilioRes.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    twilioRes.pipe(res);
  }).on('error', (err) => {
    console.error(`[Leads] Voicemail playback: fetch failed for lead ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch recording' });
  });
});

// PATCH /api/leads/:id/status — update lead status
router.patch('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`
    });
  }

  try {
    const result = db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    updated.key_points = JSON.parse(updated.key_points);
    return res.json(updated);
  } catch (err) {
    console.error('Error updating status:', err);
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

// PATCH /api/leads/:id/category — update lead category
router.patch('/:id/category', (req, res) => {
  const { id } = req.params;
  const { category } = req.body;

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`
    });
  }

  try {
    const result = db.prepare('UPDATE leads SET category = ? WHERE id = ?').run(category, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    updated.key_points = JSON.parse(updated.key_points);
    return res.json(updated);
  } catch (err) {
    console.error('Error updating category:', err);
    return res.status(500).json({ error: 'Failed to update category' });
  }
});

// PATCH /api/leads/:id/archive — toggle archived state
router.patch('/:id/archive', (req, res) => {
  const { id } = req.params;
  const { archived } = req.body; // boolean

  try {
    const result = db.prepare('UPDATE leads SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    updated.key_points = JSON.parse(updated.key_points);
    return res.json(updated);
  } catch (err) {
    console.error('Error archiving lead:', err);
    return res.status(500).json({ error: 'Failed to archive lead' });
  }
});

// DELETE /api/leads/:id — permanently delete a lead
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  try {
    const result = db.prepare('DELETE FROM leads WHERE id = ?').run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting lead:', err);
    return res.status(500).json({ error: 'Failed to delete lead' });
  }
});

module.exports = router;
module.exports.createLeadFromTranscript = createLeadFromTranscript;
module.exports.isDuplicate = isDuplicate;
