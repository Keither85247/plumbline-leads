#!/usr/bin/env node
/**
 * Creates user accounts with API keys for tester access.
 * Run once from the backend directory:
 *
 *   node scripts/seed-users.js
 *
 * Outputs the generated API keys — give each tester their key.
 * Re-running is safe: existing users are skipped (INSERT OR IGNORE).
 *
 * Tester clients set the header:
 *   X-API-Key: <key>
 */
'use strict';
const crypto = require('crypto');
const db     = require('../db');

const TESTERS = [
  { email: 'keith@plumblineleads.com',  display_name: 'Keith' },
  { email: 'tester1@plumblineleads.com', display_name: 'Tester 1' },
  { email: 'tester2@plumblineleads.com', display_name: 'Tester 2' },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO users (email, display_name, api_key)
  VALUES (?, ?, ?)
`);

console.log('\nPlumbline Leads — user seed\n');

for (const t of TESTERS) {
  const existing = db.prepare('SELECT api_key FROM users WHERE email = ?').get(t.email);
  if (existing) {
    console.log(`${t.display_name.padEnd(12)} ${t.email.padEnd(36)} key: ${existing.api_key}  (already exists)`);
    continue;
  }
  const key = crypto.randomBytes(24).toString('hex');
  insert.run(t.email, t.display_name, key);
  console.log(`${t.display_name.padEnd(12)} ${t.email.padEnd(36)} key: ${key}  ← NEW`);
}

console.log('\nAdd X-API-Key: <key> to every API request to authenticate.\n');
