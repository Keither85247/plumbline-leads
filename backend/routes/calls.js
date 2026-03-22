const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/calls — return recent incoming calls, newest first
router.get('/', (req, res) => {
  try {
    const calls = db.prepare(
      'SELECT * FROM calls ORDER BY created_at DESC LIMIT 50'
    ).all();
    return res.json(calls);
  } catch (err) {
    console.error('Error fetching calls:', err);
    return res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

module.exports = router;
