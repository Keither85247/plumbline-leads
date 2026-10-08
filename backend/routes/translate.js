const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { translateLimits, translateRateLimit } = require('../utils/aiBudget');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });

// Only these targets are accepted; the value is never interpolated from input.
const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  es: 'Spanish',
});
const MAX_TRANSLATE_CHARS = 5000;

// Validate before the budget so only real translation requests are counted.
// Responses are fixed text — submitted content is never echoed or logged.
function validateTranslate(req, res, next) {
  const { text, targetLang } = req.body || {};
  if (typeof text !== 'string' || !text.trim()
      || typeof targetLang !== 'string' || !Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, targetLang)) {
    return res.status(400).json({ error: 'text and a supported targetLang are required' });
  }
  if (text.length > MAX_TRANSLATE_CHARS) {
    return res.status(413).json({ error: 'Text is too long to translate' });
  }
  next();
}

// POST /api/translate  (behind requireAuth)
// Body: { text: string (≤5000 chars), targetLang: 'en' | 'es' }
// Returns: { translated: string }
router.post('/', validateTranslate, translateRateLimit, async (req, res) => {
  const { text, targetLang } = req.body;
  const targetLanguage = LANGUAGE_NAMES[targetLang];

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 2500,
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate the following text to ${targetLanguage}. Preserve the tone — keep it friendly and conversational. Return only the translated text, nothing else.`,
        },
        { role: 'user', content: text },
      ],
    });

    const translated = completion.choices[0].message.content?.trim();
    if (!translated) throw new Error('Empty translation response');

    res.json({ translated });
  } catch (err) {
    // Error codes only — never the submitted or translated text.
    console.error(`[Translate] Failed for user ${req.userId}: ${err?.status || err?.code || err?.name || 'error'}`);
    res.status(500).json({ error: 'Translation failed' });
  }
});

module.exports = router;
module.exports.translateLimits = translateLimits;   // for tests
