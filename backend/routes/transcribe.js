const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const OpenAI = require('openai');
const { createLeadFromTranscript } = require('./leads');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Store uploads in /tmp so they are cleaned up by the OS
const upload = multer({
  dest: '/tmp/',
  // 25 MB — OpenAI Whisper limit. One file, and only small text fields
  // (language), so a single request cannot buffer unbounded form data.
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-m4a', 'audio/m4a', 'video/mp4'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(mp3|mp4|m4a|wav)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Use mp3, m4a, wav, or mp4.'));
    }
  }
});

// POST /api/transcribe — upload audio, transcribe with Whisper, create lead.
// Mounted behind requireAuth: the lead is always owned by the authenticated
// account (req.userId). No user id is ever read from the request body.
router.post('/', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Audio file is required' });
  }

  const filePath = req.file.path;
  let renamedPath = null;

  try {
    // Rename to preserve original extension — Whisper requires it
    const ext = req.file.originalname.split('.').pop();
    renamedPath = `${filePath}.${ext}`;
    fs.renameSync(filePath, renamedPath);

    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(renamedPath),
    });

    fs.unlinkSync(renamedPath);

    const transcript = transcription.text;

    if (!transcript || transcript.trim().length === 0) {
      return res.status(422).json({ error: 'Transcription returned empty text' });
    }

    const newLead = await createLeadFromTranscript({
      transcript,
      rawText: transcript,
      language: req.body.language || undefined,
      userId: req.userId,
    });

    return res.status(201).json({ transcript, lead: newLead });
  } catch (err) {
    // Clean up the upload whichever name it has
    try { fs.unlinkSync(filePath); } catch {}
    if (renamedPath) { try { fs.unlinkSync(renamedPath); } catch {} }
    console.error('Transcription error:', err.message);
    if (err?.status === 401) {
      return res.status(502).json({ error: 'Invalid OpenAI API key.' });
    }
    return res.status(500).json({ error: 'Transcription failed' });
  }
});

module.exports = router;
