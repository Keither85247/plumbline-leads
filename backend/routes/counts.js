const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/counts
// Returns actionable badge counts for the four nav tabs.
// One lightweight query per table, one request from the client.
//
//  calls  — missed inbound calls in last 48h (rang but no answer, no voicemail)
//  texts  — conversations where the last message is inbound (waiting for a reply)
//  emails — unread inbound emails that haven't been deleted or archived

router.get('/', (req, res) => {
  try {
    // Missed inbound calls: no duration, no transcript, not Outbound, within 48h
    const { calls } = db.prepare(`
      SELECT COUNT(*) AS calls FROM calls
      WHERE classification != 'Outbound'
        AND (duration IS NULL OR duration = 0)
        AND transcript IS NULL
        AND created_at > datetime('now', '-48 hours')
    `).get();

    // Unread text conversations: phones where the most recent message is inbound
    const { texts } = db.prepare(`
      SELECT COUNT(DISTINCT m.phone) AS texts
      FROM messages m
      WHERE m.direction = 'inbound'
        AND m.id = (
          SELECT id FROM messages m2
          WHERE m2.phone = m.phone
          ORDER BY m2.created_at DESC
          LIMIT 1
        )
    `).get();

    // Unread inbound emails (is_read = 0 set by Gmail poller for new mail)
    const { emails } = db.prepare(`
      SELECT COUNT(*) AS emails FROM emails
      WHERE direction = 'inbound'
        AND is_read = 0
        AND (is_deleted  IS NULL OR is_deleted  = 0)
        AND (is_archived IS NULL OR is_archived = 0)
    `).get();

    res.json({ calls: calls || 0, texts: texts || 0, emails: emails || 0 });
  } catch (err) {
    console.error('[Counts]', err.message);
    res.status(500).json({ error: 'Failed to fetch counts' });
  }
});

module.exports = router;
