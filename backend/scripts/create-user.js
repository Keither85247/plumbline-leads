#!/usr/bin/env node
/**
 * One-time bootstrap script — creates the first user account.
 *
 * Usage (run from the backend directory):
 *   node scripts/create-user.js
 *
 * You will be prompted for:
 *   email        — the login email address
 *   display_name — shown in the app header
 *   password     — hashed with bcrypt before storage
 *
 * After creating the user, the script offers to assign all legacy data rows
 * (user_id IS NULL) to this user. Say yes for the first real user so that
 * all historical leads, calls, messages, emails, and contacts belong to them.
 *
 * Run multiple times to add more users — existing emails are skipped.
 */
'use strict';

const readline = require('readline');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const db       = require('../db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// Hide password input (basic — not invisible on Windows cmd.exe)
function askPassword(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pwd = '';
    const handler = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0003') {
        stdin.setRawMode && stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(pwd);
      } else if (ch === '\u007F') {
        if (pwd.length > 0) { pwd = pwd.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        pwd += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', handler);
  });
}

async function main() {
  console.log('\nPlumbline Leads — create user\n');

  const email       = (await ask('Email address: ')).trim().toLowerCase();
  const displayName = (await ask('Display name:  ')).trim();
  const password    = await askPassword('Password:      ');

  if (!email || !password) {
    console.error('\nEmail and password are required.');
    process.exit(1);
  }

  // Check for existing user
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    console.log(`\nUser already exists (id: ${existing.id}). No changes made.`);
    rl.close();
    process.exit(0);
  }

  const hash   = await bcrypt.hash(password, 12);
  const apiKey = crypto.randomBytes(24).toString('hex');

  const result = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, api_key)
    VALUES (?, ?, ?, ?)
  `).run(email, displayName || email, hash, apiKey);

  const userId = result.lastInsertRowid;
  console.log(`\n✓ User created — id: ${userId}  email: ${email}`);

  // ── Assign legacy data ─────────────────────────────────────────────────────
  // All rows with user_id IS NULL were created before auth existed.
  // Assigning them to this user means they show up in the app immediately and
  // the transitional OR-NULL clauses in the routes stop returning them to
  // other users once more accounts are added.

  const assign = (await ask('\nAssign all existing data (leads, calls, messages, emails, contacts) to this user? [Y/n] ')).trim().toLowerCase();

  if (assign !== 'n' && assign !== 'no') {
    const tables = ['leads', 'calls', 'messages', 'emails', 'contacts'];
    let total = 0;
    for (const table of tables) {
      try {
        const info = db.prepare(
          `UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`
        ).run(userId);
        if (info.changes > 0) {
          console.log(`  ${table.padEnd(10)} ${info.changes} rows assigned`);
          total += info.changes;
        }
      } catch (err) {
        console.warn(`  ${table.padEnd(10)} skipped — ${err.message}`);
      }
    }
    console.log(`\n✓ ${total} total rows assigned to user ${userId}`);
  } else {
    console.log('\nSkipped data assignment. Legacy rows remain with user_id = NULL.');
    console.log('They will be visible to all logged-in users until assigned.');
  }

  console.log('\nDone. You can now log in at the app with your email and password.\n');
  rl.close();
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
