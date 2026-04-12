const express = require('express');
const router  = express.Router();
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const multer  = require('multer');
const db      = require('../db');

// Lazy-load twilio client so the route still works if TWILIO_* vars are missing
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  const twilio = require('twilio');
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Normalize to E.164 or 10-digit for consistent storage + matching
function normalizePhone(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return num.trim();
}

// ---------------------------------------------------------------------------
// MMS media storage — temp files served to Twilio during outbound send.
// Files only need to live long enough for Twilio to fetch them (seconds).
// They are deleted 30 minutes after send. Render's ephemeral disk is fine.
// ---------------------------------------------------------------------------
const MMS_TMP_DIR = path.join(os.tmpdir(), 'plumbline-mms');
if (!fs.existsSync(MMS_TMP_DIR)) fs.mkdirSync(MMS_TMP_DIR, { recursive: true });

// Image MIME types supported for MMS
const MMS_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 }, // 5 MB per file, max 5 files
  fileFilter(_req, file, cb) {
    cb(null, MMS_MIME_TYPES.has(file.mimetype));
  },
});

// ---------------------------------------------------------------------------
// GET /api/messages/media/:filename
// Serves a temp MMS file to Twilio (or the browser for instant optimistic preview).
// ---------------------------------------------------------------------------
router.get('/media/:filename', (req, res) => {
  // Sanitize — no path traversal
  const filename = path.basename(req.params.filename);
  const filePath = path.join(MMS_TMP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// GET /api/messages/media-proxy
// Proxies an inbound Twilio CDN media URL with Basic auth.
// Inbound MMS URLs (api.twilio.com/…/Media/…) require Account SID + Auth Token.
// Query param: url (URL-encoded Twilio media URL)
// ---------------------------------------------------------------------------
router.get('/media-proxy', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url param required');

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return res.status(500).send('Twilio credentials not configured');

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const protocol    = url.startsWith('https') ? https : http;

  protocol.get(url, { headers: { Authorization: `Basic ${credentials}` } }, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      return res.status(proxyRes.statusCode || 502).send('Media not available');
    }
    res.set('Content-Type',  proxyRes.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24h in browser
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.error('[Messages] Media proxy error:', err.message);
    res.status(500).send('Proxy error');
  });
});

// ---------------------------------------------------------------------------
// GET /api/messages
// Returns a deduplicated conversation list — one entry per unique phone number,
// with the most-recent message preview and unread count.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    // One row per phone: latest message body + ts + unread count
    const rows = db.prepare(`
      SELECT
        m.phone,
        m.body         AS lastMessage,
        m.direction    AS lastMessageDir,
        m.media_urls   AS lastMessageMedia,
        m.created_at   AS timestamp,
        SUM(CASE WHEN m.direction = 'inbound' AND m2.id IS NULL THEN 1 ELSE 0 END) AS unread,
        -- resolve contact name from leads table
        (SELECT contact_name FROM leads
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone_number,'+',''),'-',''),' ',''),'(',''),')','')
              = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(m.phone,'+',''),'-',''),' ',''),'(',''),')','')
            AND contact_name IS NOT NULL AND contact_name != 'Unknown'
          ORDER BY created_at DESC LIMIT 1) AS contact_name
      FROM messages m
      -- left-join to find messages that haven't been "read" (no outbound reply after them)
      LEFT JOIN messages m2
        ON m2.phone = m.phone AND m2.direction = 'outbound' AND m2.created_at >= m.created_at
      WHERE m.id = (
        SELECT id FROM messages m3 WHERE m3.phone = m.phone ORDER BY created_at DESC LIMIT 1
      )
      GROUP BY m.phone
      ORDER BY m.created_at DESC
    `).all();

    return res.json(rows.map(r => {
      // Normalize to 10-digit for contacts table lookup (contacts PK is always 10-digit)
      const digits = (r.phone || '').replace(/\D/g, '');
      const normalized10 = (digits.length === 11 && digits[0] === '1') ? digits.slice(1) : digits;

      // Priority 1: contractor-saved name from contacts table
      const contact = normalized10
        ? db.prepare(`SELECT name FROM contacts WHERE phone = ? AND name IS NOT NULL AND trim(name) != ''`).get(normalized10)
        : null;

      // Show "📷 Photo" preview for media-only messages
      const hasMedia = !!r.lastMessageMedia;
      const preview  = r.lastMessage || (hasMedia ? '📷 Photo' : '');

      return {
        id:             r.phone,
        phone:          r.phone,
        name:           contact?.name || r.contact_name || r.phone,
        lastMessage:    preview,
        lastMessageDir: r.lastMessageDir,
        timestamp:      r.timestamp,
        unread:         r.unread ?? 0,
      };
    }));
  } catch (err) {
    console.error('[Messages] GET / error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/messages/:phone
// Returns all messages for a single conversation, oldest first.
// ---------------------------------------------------------------------------
router.get('/:phone', (req, res) => {
  try {
    const phone = normalizePhone(decodeURIComponent(req.params.phone));
    if (!phone) return res.json([]);

    const messages = db.prepare(`
      SELECT * FROM messages
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','')
          = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(?,'+',''),'-',''),' ',''),'(',''),')','')
      ORDER BY created_at ASC
    `).all(phone);

    return res.json(messages);
  } catch (err) {
    console.error('[Messages] GET /:phone error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/messages/:phone/read
// Marks all inbound messages from a phone as read (is_read = 1).
// Called when the contractor opens a conversation thread.
// ---------------------------------------------------------------------------
router.patch('/:phone/read', (req, res) => {
  try {
    const phone = normalizePhone(decodeURIComponent(req.params.phone));
    if (!phone) return res.json({ ok: true });

    db.prepare(`
      UPDATE messages
      SET is_read = 1
      WHERE direction = 'inbound'
        AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','')
          = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(?,'+',''),'-',''),' ',''),'(',''),')','')
    `).run(phone);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[Messages] PATCH /:phone/read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages/send
// Sends an outbound SMS or MMS via Twilio and persists it to the messages table.
//
// Accepts multipart/form-data (always — even text-only sends):
//   to    — destination phone (required)
//   body  — message text (optional if media present)
//   media — one or more image files (optional)
//
// MMS flow for attached files:
//   1. Write each file to MMS_TMP_DIR with a unique name
//   2. Build a public URL: ${TWILIO_BASE_URL}/api/messages/media/<filename>
//   3. Pass those URLs to Twilio as mediaUrl[]
//   4. Twilio fetches the files, delivers to recipient, and stores them on its CDN
//   5. Store our URL(s) in media_urls JSON column for display in the thread
//   6. Schedule temp file cleanup after 30 min (Twilio has fetched them by then)
// ---------------------------------------------------------------------------
router.post('/send', upload.array('media', 5), async (req, res) => {
  const { to, body } = req.body;
  const files = req.files || [];

  if (!to) {
    return res.status(400).json({ error: 'to is required' });
  }
  if (!body?.trim() && files.length === 0) {
    return res.status(400).json({ error: 'body or at least one media file is required' });
  }

  const toE164      = normalizePhone(to);
  const fromNumber  = process.env.TWILIO_PHONE_NUMBER;
  const baseUrl     = process.env.TWILIO_BASE_URL;

  if (!fromNumber) {
    return res.status(500).json({ error: 'TWILIO_PHONE_NUMBER is not configured' });
  }
  if (files.length > 0 && !baseUrl) {
    return res.status(500).json({ error: 'TWILIO_BASE_URL must be set to send MMS' });
  }

  const client = getTwilioClient();
  if (!client) {
    return res.status(500).json({ error: 'Twilio credentials are not configured' });
  }

  // Write uploaded files to temp dir and build public URLs for Twilio.
  // All of this is inside the try so file-write failures are caught and
  // returned as JSON (not an unhandled Express HTML 500).
  const mediaUrls = [];
  const tempPaths = [];

  try {
    for (const file of files) {
      const ext      = file.mimetype.split('/')[1].replace('jpeg', 'jpg');
      const name     = `mms-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const filePath = path.join(MMS_TMP_DIR, name);
      fs.writeFileSync(filePath, file.buffer);
      tempPaths.push(filePath);
      const publicUrl = `${baseUrl}/api/messages/media/${name}`;
      mediaUrls.push(publicUrl);
      console.log(`[Messages] MMS temp file written: ${filePath} → public URL: ${publicUrl}`);
    }

    const params = {
      body: (body || '').trim(),
      from: fromNumber,
      to:   toE164,
    };
    if (mediaUrls.length > 0) params.mediaUrl = mediaUrls;

    console.log(`[Messages] Calling Twilio messages.create — to: ${toE164}, body: "${params.body}", mediaUrl: ${JSON.stringify(mediaUrls)}`);

    const message = await client.messages.create(params);

    // Persist to DB — store our media URLs so the thread can render them
    const storedMedia = mediaUrls.length > 0 ? JSON.stringify(mediaUrls) : null;
    const row = db.prepare(`
      INSERT INTO messages (phone, direction, body, twilio_sid, status, media_urls)
      VALUES (?, 'outbound', ?, ?, ?, ?)
    `).run(toE164, (body || '').trim(), message.sid, message.status || 'sent', storedMedia);

    // Clean up temp files after 30 min — Twilio will have fetched them by then
    if (tempPaths.length > 0) {
      setTimeout(() => {
        tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
      }, 30 * 60 * 1000);
    }

    console.log(`[Messages] Sent ${mediaUrls.length > 0 ? 'MMS' : 'SMS'} to ${toE164} — SID: ${message.sid}`);
    return res.json({ ok: true, id: row.lastInsertRowid, sid: message.sid });
  } catch (err) {
    // Clean up any temp files that were written before the failure
    tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
    // Log the full Twilio error: message + code + moreInfo
    const twilioCode = err.code || err.status || '';
    const twilioMore = err.moreInfo || '';
    console.error(`[Messages] Send error${twilioCode ? ` (Twilio ${twilioCode})` : ''}:`, err.message, twilioMore);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
