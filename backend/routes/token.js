const express = require('express');
const router = express.Router();
const twilio = require('twilio');

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// GET /api/twilio/token
// Returns a short-lived Twilio Access Token for the Voice SDK.
// The token grants outgoing + incoming call capability to the 'contractor' identity.
// Requires:
//   TWILIO_ACCOUNT_SID   — your Twilio account SID
//   TWILIO_API_KEY       — API Key SID (starts with SK), from console.twilio.com → API Keys
//   TWILIO_API_SECRET    — API Key Secret (shown once at creation)
//   TWILIO_TWIML_APP_SID — TwiML App SID (starts with AP), whose Voice URL is
//                          TWILIO_BASE_URL/api/twilio/voice-client
router.get('/', (req, res) => {
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || process.env.TWILIO_API_KEY;
  const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_API_SECRET;
  const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID;

  const missing = [];
  if (!TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!TWILIO_API_KEY_SID) missing.push('TWILIO_API_KEY / TWILIO_API_KEY_SID');
  if (!TWILIO_API_KEY_SECRET) missing.push('TWILIO_API_SECRET / TWILIO_API_KEY_SECRET');
  if (!TWILIO_TWIML_APP_SID) missing.push('TWILIO_TWIML_APP_SID');

  if (missing.length) {
    console.error('[Token] Missing env vars:', missing.join(', '));
    return res.status(500).json({
      error: `Voice SDK not configured. Missing: ${missing.join(', ')}`,
    });
  }

  try {
    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity: 'contractor', ttl: 3600 }
    );

    token.addGrant(new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    }));

    console.log('[Token] Voice token issued for identity: contractor');
    return res.json({ token: token.toJwt(), identity: 'contractor' });
  } catch (err) {
    console.error('[Token] Failed to generate token:', err.message);
    return res.status(500).json({ error: 'Token generation failed' });
  }
});

module.exports = router;
