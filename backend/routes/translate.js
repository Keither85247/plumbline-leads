const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish',
};

// POST /api/translate
// Body: { text: string, targetLang: 'en' | 'es' }
// Returns: { translated: string }
router.post('/', express.json(), async (req, res) => {
  const { text, targetLang } = req.body;

  if (!text || !targetLang) {
    return res.status(400).json({ error: 'text and targetLang are required' });
  }

  const targetLanguage = LANGUAGE_NAMES[targetLang] || targetLang;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
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
    console.error('[Translate] Error:', err.message);
    res.status(500).json({ error: 'Translation failed' });
  }
});

module.exports = router;
