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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — OpenAI Whisper limit
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-m4a', 'audio/m4a', 'video/mp4'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(mp3|mp4|m4a|wav)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Use mp3, m4a, wav, or mp4.'));
    }
  }
});

// POST /api/transcribe — upload audio, transcribe with Whisper, create lead
router.post('/', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Audio file is required' });
  }

  const filePath = req.file.path;

  try {
    // Rename to preserve original extension — Whisper requires it
    const ext = req.file.originalname.split('.').pop();
    const renamedPath = `${filePath}.${ext}`;
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
    });

    return res.status(201).json({ transcript, lead: newLead });
  } catch (err) {
    // Clean up file if still present
    try { fs.unlinkSync(filePath); } catch {}
    console.error('Transcription error:', err);
    if (err?.status === 401) {
      return res.status(502).json({ error: 'Invalid OpenAI API key.' });
    }
    return res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

module.exports = router;
