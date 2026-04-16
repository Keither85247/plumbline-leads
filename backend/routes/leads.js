const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const db = require('../db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VALID_STATUSES   = ['New', 'Contacted', 'Qualified', 'Closed'];
const VALID_CATEGORIES = ['Lead', 'Existing Customer', 'Vendor', 'Spam', 'Other'];
const STATUS_ORDER     = { New: 0, Contacted: 1, Qualified: 2, Closed: 3 };

// ---------------------------------------------------------------------------
// createLeadFromTranscript
// Shared logic: call OpenAI, save lead, return the saved row.
// userId is optional — Twilio webhook callers pass null (legacy row); the
// /api/leads POST route passes req.userId so the lead is user-scoped.
// ---------------------------------------------------------------------------
async function createLeadFromTranscript({
  transcript,
  rawText,
  contactNameFallback = 'Unknown',
  phoneNumber         = null,
  source              = 'voicemail',
  language,
  recordingUrl        = null,
  userId              = null,    // ← Phase 1 addition
}) {
  const lang = language || process.env.LANGUAGE || 'en';
  const languageInstruction = lang === 'es'
    ? '\n- IMPORTANT: Write the "summary", all "keyPoints" strings, and "followUpText" in Spanish (Español). Keep all JSON field names in English.'
    : '';

  const isSms = source === 'sms';
  const medium = isSms ? 'SMS message' : 'call transcript or voicemail';
  const summaryExamples = isSms
    ? '"Mike – Texted about a leaking pipe under the kitchen sink", "Sandra – Asked for a quote on a water heater replacement", "Texted asking about availability, no name given"'
    : '"Gonzo (Advanced Paint) – Called about paint pickup", "Mike – Asked for an estimate on a bathroom remodel", "Called about a broken water heater, no name given"';
  const followUpExample = isSms
    ? '"Hi Mike, this is [Your Name]. Got your text about the leaking pipe. Happy to help — what\'s a good time to swing by?"'
    : '"Hi Mike, this is [Your Name]. Got your call about the breaker panel and outdoor lighting. Happy to help. Let me know a good time to connect."';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a CRM assistant that analyzes contractor ${medium}s. Return a JSON object with exactly these fields:
- "contactName": string — the primary contact's full name extracted from the message, or "Unknown" if not identifiable
- "companyName": string — the business or organization the contact represents. Only include if explicitly stated or clearly implied. Do not guess. Return an empty string if unclear.
- "category": string — classify the contact into exactly one of these values: "Lead" (new job inquiry, estimate request, potential sale), "Existing Customer" (service issue, follow-up, complaint, or existing project), "Vendor" (supplier, partner, subcontractor, or business contact), "Spam" (robocall, irrelevant solicitation, obvious junk), "Other" (unclear or does not fit above). Return only the exact string value.
- "summary": string — a single concise sentence: "[Name] – [what this was about]". If no company, omit the parenthetical. If name is unknown, start with just the action. Keep it short and factual. Examples: ${summaryExamples}
- "keyPoints": array of strings — up to 3 short, contractor-focused bullet points. Prioritize: (1) job location or address if mentioned, (2) type of work or service requested, (3) urgency, timing, or requested next step. Do NOT include anything about contact info. Do NOT repeat what is already in the summary. Every bullet should be new, specific, actionable information a contractor needs.
- "callbackNumber": string — if the contact explicitly states a different number to reach them (e.g. "call me back at 203-555-1234"), extract it. Otherwise return an empty string.
- "followUpText": string — a short, natural SMS-style follow-up message the contractor would send. Reference the specific request, suggest a next step, sound like a real person texting (not a template), no emojis. Use [Your Name] as placeholder. Example: ${followUpExample}${languageInstruction}`
      },
      {
        role: 'user',
        content: `Analyze this ${medium}:\n\n${transcript}`
      }
    ]
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  const {
    contactName  = 'Unknown',
    companyName  = '',
    category     = 'Other',
    summary      = '',
    keyPoints    = [],
    callbackNumber = '',
    followUpText = '',
  } = parsed;

  const resolvedName     = contactName === 'Unknown' ? contactNameFallback : contactName;
  const resolvedCompany  = typeof companyName === 'string' ? companyName.trim() : '';
  const resolvedCategory = VALID_CATEGORIES.includes(category) ? category : 'Other';
  const extractedCallback = typeof callbackNumber === 'string' ? callbackNumber.trim() : '';

  const result = db.prepare(
    `INSERT INTO leads
       (transcript, raw_text, contact_name, company_name, phone_number,
        callback_number, summary, key_points, follow_up_text, category,
        source, recording_url, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    recordingUrl || null,
    userId,
  );
  console.log(`[Leads] Lead created — id:${result.lastInsertRowid} source:${source} user:${userId ?? 'legacy'}`);

  const newLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
  newLead.key_points = JSON.parse(newLead.key_points);
  return newLead;
}

// Duplicate check — global (prevents double-processing the same Twilio webhook)
function isDuplicate(phoneNumber, transcript) {
  if (!phoneNumber) return false;
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const existing = db.prepare(
    'SELECT id FROM leads WHERE phone_number = ? AND transcript = ? AND created_at > ?'
  ).get(phoneNumber, transcript, fiveMinutesAgo);
  return !!existing;
}

// Same-day lead check — global (prevents repeated SMS creating duplicate leads)
function hasLeadToday(phoneNumber) {
  if (!phoneNumber) return false;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existing = db.prepare(
    `SELECT id FROM leads
     WHERE (phone_number = ? OR callback_number = ?)
       AND created_at > ?
       AND archived = 0`
  ).get(phoneNumber, phoneNumber, oneDayAgo);
  return !!existing;
}

// ---------------------------------------------------------------------------
// POST /api/leads — manual transcript submission (user-initiated from the UI)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { transcript } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: 'Transcript is required' });
  }

  try {
    const newLead = await createLeadFromTranscript({
      transcript,
      rawText:  req.body.rawText || transcript,
      language: req.body.language || undefined,
      userId:   req.userId,   // ← scoped to the logged-in user
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

// ---------------------------------------------------------------------------
// GET /api/leads
// TRANSITIONAL: includes NULL user_id rows so legacy + Twilio-created leads
// remain visible until all rows are claimed (see scripts/create-user.js).
// Remove the "OR l.user_id IS NULL" clause once Phase 2 Twilio scoping is done.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const showArchived = req.query.archived === 'true';
    const { source } = req.query;

    let query = `
      SELECT l.*,
        (SELECT COUNT(*) FROM messages m
         WHERE m.phone = l.phone_number OR m.phone = l.callback_number) AS message_count,
        (SELECT MAX(m.created_at) FROM messages m
         WHERE m.phone = l.phone_number OR m.phone = l.callback_number) AS last_message_at
      FROM leads l
      WHERE l.archived = ?
        AND (l.user_id = ? OR l.user_id IS NULL)`;
    const params = [showArchived ? 1 : 0, req.userId];

    if (source) {
      query += ' AND l.source = ?';
      params.push(source);
    }
    query += ' ORDER BY l.created_at DESC';

    const leads = db.prepare(query).all(...params);
    const result = leads.map(lead => ({
      ...lead,
      key_points: JSON.parse(lead.key_points),
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

// ---------------------------------------------------------------------------
// GET /api/leads/:id/voicemail — proxy Twilio recording audio with Basic auth
// ---------------------------------------------------------------------------
router.get('/:id/voicemail', (req, res) => {
  const lead = db.prepare(
    'SELECT recording_url FROM leads WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
  ).get(req.params.id, req.userId);

  if (!lead) {
    console.warn(`[Leads] Voicemail: lead ${req.params.id} not found or not owned by user ${req.userId}`);
    return res.status(404).json({ error: 'Lead not found' });
  }
  if (!lead.recording_url) {
    return res.status(404).json({ error: 'No recording available for this lead' });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  const audioUrl = lead.recording_url.endsWith('.mp3')
    ? lead.recording_url
    : `${lead.recording_url}.mp3`;

  const credentials  = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const protocol     = audioUrl.startsWith('https') ? require('https') : require('http');
  const upstreamHeaders = { Authorization: `Basic ${credentials}` };
  if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

  protocol.get(audioUrl, { headers: upstreamHeaders }, (twilioRes) => {
    const status = twilioRes.statusCode;
    if (status !== 200 && status !== 206) {
      twilioRes.resume();
      return res.status(502).json({ error: `Twilio returned ${status}` });
    }
    res.setHeader('Content-Type',  twilioRes.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes'); // required by Safari — declare range support unconditionally
    if (twilioRes.headers['content-length']) res.setHeader('Content-Length', twilioRes.headers['content-length']);
    if (twilioRes.headers['content-range'])  res.setHeader('Content-Range',  twilioRes.headers['content-range']);
    res.status(status);
    twilioRes.pipe(res);
  }).on('error', (err) => {
    res.status(500).json({ error: 'Failed to fetch recording' });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/leads/:id/status
// ---------------------------------------------------------------------------
router.patch('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const result = db.prepare(
      'UPDATE leads SET status = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
    ).run(status, id, req.userId);

    if (result.changes === 0) return res.status(404).json({ error: 'Lead not found' });

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    updated.key_points = JSON.parse(updated.key_points);
    return res.json(updated);
  } catch (err) {
    console.error('Error updating status:', err);
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/leads/:id/category
// ---------------------------------------------------------------------------
router.patch('/:id/category', (req, res) => {
  const { id } = req.params;
  const { category } = req.body;

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  try {
    const result = db.prepare(
      'UPDATE leads SET category = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
    ).run(category, id, req.userId);

    if (result.changes === 0) return res.status(404).json({ error: 'Lead not found' });

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    updated.key_points = JSON.parse(updated.key_points);
    return res.json(updated);
  } catch (err) {
    console.error('Error updating category:', err);
    return res.status(500).json({ error: 'Failed to update category' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/leads/:id/archive
// ---------------------------------------------------------------------------
router.patch('/:id/archive', (req, res) => {
  const { id } = req.params;
  const { archived } = req.body;

  try {
    const result = db.prepare(
      'UPDATE leads SET archived = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
    ).run(archived ? 1 : 0, id, req.userId);

    if (result.changes === 0) return res.status(404).json({ error: 'Lead not found' });

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    updated.key_points = JSON.parse(updated.key_points);
    return res.json(updated);
  } catch (err) {
    console.error('Error archiving lead:', err);
    return res.status(500).json({ error: 'Failed to archive lead' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/leads/:id
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  try {
    const result = db.prepare(
      'DELETE FROM leads WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
    ).run(id, req.userId);

    if (result.changes === 0) return res.status(404).json({ error: 'Lead not found' });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting lead:', err);
    return res.status(500).json({ error: 'Failed to delete lead' });
  }
});

module.exports = router;
module.exports.createLeadFromTranscript = createLeadFromTranscript;
module.exports.isDuplicate = isDuplicate;
module.exports.hasLeadToday = hasLeadToday;
