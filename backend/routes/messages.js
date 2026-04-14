const express = require('express');
const router  = express.Router();
const log     = require('../logger').for('Messages');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const multer  = require('multer');
const db      = require('../db');

function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  const twilio = require('twilio');
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function normalizePhone(num) {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return num.trim();
}

// ---------------------------------------------------------------------------
// MMS temp file storage
// ---------------------------------------------------------------------------
const MMS_TMP_DIR = path.join(os.tmpdir(), 'plumbline-mms');
if (!fs.existsSync(MMS_TMP_DIR)) fs.mkdirSync(MMS_TMP_DIR, { recursive: true });

const MMS_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter(_req, file, cb) { cb(null, MMS_MIME_TYPES.has(file.mimetype)); },
});

// ---------------------------------------------------------------------------
// GET /api/messages/media/:filename  — serve temp MMS file to Twilio / browser
// ---------------------------------------------------------------------------
router.get('/media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(MMS_TMP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// GET /api/messages/media-proxy  — proxy inbound Twilio CDN media (auth required)
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
    res.set('Cache-Control', 'public, max-age=86400');
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.error('[Messages] Media proxy error:', err.message);
    res.status(500).send('Proxy error');
  });
});

// ---------------------------------------------------------------------------
// GET /api/messages
// Returns conversation list — one entry per phone, latest message + unread count.
// TRANSITIONAL: includes NULL user_id rows (Twilio-created inbound messages) until
// Phase 2 sets user_id in the Twilio SMS webhook handler.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        m.phone,
        m.body         AS lastMessage,
        m.direction    AS lastMessageDir,
        m.media_urls   AS lastMessageMedia,
        m.created_at   AS timestamp,
        SUM(CASE WHEN m.direction = 'inbound' AND m2.id IS NULL THEN 1 ELSE 0 END) AS unread,
        (SELECT contact_name FROM leads
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone_number,'+',''),'-',''),' ',''),'(',''),')','')
              = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(m.phone,'+',''),'-',''),' ',''),'(',''),')','')
            AND contact_name IS NOT NULL AND contact_name != 'Unknown'
            AND (user_id = ? OR user_id IS NULL)
          ORDER BY created_at DESC LIMIT 1) AS contact_name
      FROM messages m
      LEFT JOIN messages m2
        ON m2.phone = m.phone AND m2.direction = 'outbound' AND m2.created_at >= m.created_at
      WHERE m.id = (
        SELECT id FROM messages m3
        WHERE m3.phone = m.phone
          AND (m3.user_id = ? OR m3.user_id IS NULL)
        ORDER BY created_at DESC LIMIT 1
      )
      AND (m.user_id = ? OR m.user_id IS NULL)
      GROUP BY m.phone
      ORDER BY m.created_at DESC
    `).all(req.userId, req.userId, req.userId);

    return res.json(rows.map(r => {
      const digits       = (r.phone || '').replace(/\D/g, '');
      const normalized10 = (digits.length === 11 && digits[0] === '1') ? digits.slice(1) : digits;

      const contact = normalized10
        ? db.prepare(
            `SELECT name FROM contacts
             WHERE phone = ?
               AND (user_id = ? OR user_id IS NULL)
               AND name IS NOT NULL AND trim(name) != ''`
          ).get(normalized10, req.userId)
        : null;

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
    log.error('GET / failed', { err: err.message });
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/messages/:phone
// ---------------------------------------------------------------------------
router.get('/:phone', (req, res) => {
  try {
    const phone = normalizePhone(decodeURIComponent(req.params.phone));
    if (!phone) return res.json([]);

    const messages = db.prepare(`
      SELECT * FROM messages
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','')
          = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(?,'+',''),'-',''),' ',''),'(',''),')','')
        AND (user_id = ? OR user_id IS NULL)
      ORDER BY created_at ASC
    `).all(phone, req.userId);

    return res.json(messages);
  } catch (err) {
    console.error('[Messages] GET /:phone error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/messages/:phone/read
// ---------------------------------------------------------------------------
router.patch('/:phone/read', (req, res) => {
  try {
    const phone = normalizePhone(decodeURIComponent(req.params.phone));
    if (!phone) return res.json({ ok: true });

    db.prepare(`
      UPDATE messages
      SET is_read = 1
      WHERE direction = 'inbound'
        AND (user_id = ? OR user_id IS NULL)
        AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','')
          = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(?,'+',''),'-',''),' ',''),'(',''),')','')
    `).run(req.userId, phone);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[Messages] PATCH /:phone/read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages/send — outbound SMS or MMS via Twilio
// ---------------------------------------------------------------------------
router.post('/send', upload.array('media', 5), async (req, res) => {
  const { to, body } = req.body;
  const files = req.files || [];

  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!body?.trim() && files.length === 0) {
    return res.status(400).json({ error: 'body or at least one media file is required' });
  }

  const toE164     = normalizePhone(to);
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const baseUrl    = process.env.TWILIO_BASE_URL;

  if (!fromNumber) return res.status(500).json({ error: 'TWILIO_PHONE_NUMBER is not configured' });
  if (files.length > 0 && !baseUrl) return res.status(500).json({ error: 'TWILIO_BASE_URL must be set to send MMS' });

  const client = getTwilioClient();
  if (!client) return res.status(500).json({ error: 'Twilio credentials are not configured' });

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
      log.info('MMS temp file written', { publicUrl });
    }

    const params = { body: (body || '').trim(), from: fromNumber, to: toE164 };
    if (mediaUrls.length > 0) params.mediaUrl = mediaUrls;

    log.info('Calling Twilio messages.create', { to: toE164, bodyLen: params.body?.length, mediaCount: mediaUrls.length });

    const message = await client.messages.create(params);

    const storedMedia = mediaUrls.length > 0 ? JSON.stringify(mediaUrls) : null;
    const row = db.prepare(`
      INSERT INTO messages (phone, direction, body, twilio_sid, status, media_urls, user_id)
      VALUES (?, 'outbound', ?, ?, ?, ?, ?)
    `).run(toE164, (body || '').trim(), message.sid, message.status || 'sent', storedMedia, req.userId);

    if (tempPaths.length > 0) {
      setTimeout(() => {
        tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
      }, 30 * 60 * 1000);
    }

    log.info(`${mediaUrls.length > 0 ? 'MMS' : 'SMS'} sent`, { to: toE164, sid: message.sid, status: message.status });
    return res.json({ ok: true, id: row.lastInsertRowid, sid: message.sid });
  } catch (err) {
    tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
    const twilioCode = err.code || err.status || '';
    const twilioMore = err.moreInfo || '';
    log.error('Send failed', { to: toE164, twilioCode, err: err.message, moreInfo: twilioMore });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
