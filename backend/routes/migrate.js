'use strict';
/**
 * TEMPORARY MIGRATION ENDPOINT — REMOVE AFTER USE
 *
 * POST /api/migrate — bulk-imports legacy leads/calls rows.
 * Mounted AFTER requireAuth; requireOwner restricts it to the owner account.
 * Every imported row is stamped with the importing owner's user_id so the
 * endpoint never creates rows without a verified owning account.
 */

const express      = require('express');
const db           = require('../db');
const requireOwner = require('../middleware/requireOwner');

const router = express.Router();

router.post('/', requireOwner, (req, res) => {
  const { leads = [], calls = [] } = req.body || {};
  let leadsInserted = 0;
  let callsInserted = 0;
  const insertLead = db.prepare(`INSERT OR IGNORE INTO leads (id,transcript,raw_text,contact_name,company_name,phone_number,callback_number,summary,key_points,follow_up_text,category,source,recording_url,status,archived,created_at,user_id) VALUES (@id,@transcript,@raw_text,@contact_name,@company_name,@phone_number,@callback_number,@summary,@key_points,@follow_up_text,@category,@source,@recording_url,@status,@archived,@created_at,@user_id)`);
  const insertCall = db.prepare(`INSERT OR IGNORE INTO calls (id,from_number,call_sid,classification,status,recording_url,duration,transcript,summary,key_points,contractor_note,outcome,created_at,user_id) VALUES (@id,@from_number,@call_sid,@classification,@status,@recording_url,@duration,@transcript,@summary,@key_points,@contractor_note,@outcome,@created_at,@user_id)`);
  const runAll = db.transaction(() => {
    for (const lead of leads) leadsInserted += insertLead.run({ ...lead, user_id: req.userId }).changes;
    for (const call of calls) callsInserted += insertCall.run({ ...call, user_id: req.userId }).changes;
  });
  try {
    runAll();
    console.log(`[Migrate] ${leadsInserted} leads, ${callsInserted} calls`);
    res.json({ ok: true, leadsInserted, callsInserted });
  } catch (err) {
    console.error('[Migrate]', err.message);
    res.status(500).json({ error: 'Migration failed' });
  }
});

module.exports = router;
