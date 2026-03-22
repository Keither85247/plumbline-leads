require('dotenv').config();
const express = require('express');
const cors = require('cors');
const leadsRouter = require('./routes/leads');
const twilioRouter = require('./routes/twilio');
const transcribeRouter = require('./routes/transcribe');
const callsRouter = require('./routes/calls');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api/leads', leadsRouter);
app.use('/api/twilio', twilioRouter);
app.use('/api/transcribe', transcribeRouter);
app.use('/api/calls', callsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
