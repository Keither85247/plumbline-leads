const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/counts
// Returns badge counts scoped to the authenticated user.
// TRANSITIONAL: each query includes NULL user_id rows so legacy data counts
// until all rows are assigned (create-user.js --assign step).

router.get('/', (req, res) => {
  try {
    const userId = req.userId;

    // Missed inbound calls: no duration, no transcript, not Outbound, within 48h, not yet seen
    const { calls } = db.prepare(`
      SELECT COUNT(*) AS calls FROM calls
      WHERE (user_id = ? OR user_id IS NULL)
        AND classification != 'Outbound'
        AND (duration IS NULL OR duration = 0)
        AND transcript IS NULL
        AND created_at > datetime('now', '-48 hours')
        AND (is_seen IS NULL OR is_seen = 0)
    `).get(userId);

    // Unread text conversations: phones where the most recent message is inbound AND unread
    const { texts } = db.prepare(`
      SELECT COUNT(DISTINCT m.phone) AS texts
      FROM messages m
      WHERE m.direction = 'inbound'
        AND (m.is_read IS NULL OR m.is_read = 0)
        AND (m.user_id = ? OR m.user_id IS NULL)
        AND m.id = (
          SELECT id FROM messages m2
          WHERE m2.phone = m.phone
            AND (m2.user_id = ? OR m2.user_id IS NULL)
          ORDER BY m2.created_at DESC
          LIMIT 1
        )
    `).get(userId, userId);

    // Unread inbound emails
    const { emails } = db.prepare(`
      SELECT COUNT(*) AS emails FROM emails
      WHERE direction = 'inbound'
        AND is_read = 0
        AND (is_deleted  IS NULL OR is_deleted  = 0)
        AND (is_archived IS NULL OR is_archived = 0)
        AND (user_id = ? OR user_id IS NULL)
    `).get(userId);

    res.json({ calls: calls || 0, texts: texts || 0, emails: emails || 0 });
  } catch (err) {
    console.error('[Counts]', err.message);
    res.status(500).json({ error: 'Failed to fetch counts' });
  }
});

module.exports = router;
