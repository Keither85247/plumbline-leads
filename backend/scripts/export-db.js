#!/usr/bin/env node
/**
 * export-db.js
 * Exports all leads and calls from the local SQLite DB and POSTs them to the
 * production Render backend via the /api/migrate endpoint.
 *
 * Usage:
 *   node backend/scripts/export-db.js
 *
 * It reads DB_PATH (or defaults to backend/leads.db) and RENDER_URL from env,
 * or you can pass them as arguments:
 *   DB_PATH=./backend/leads.db RENDER_URL=https://plumbline-leads.onrender.com node backend/scripts/export-db.js
 */

const path     = require('path');
const Database = require('better-sqlite3');
const https    = require('https');

const dbPath    = process.env.DB_PATH    || path.join(__dirname, '..', 'leads.db');
const renderUrl = process.env.RENDER_URL || 'https://plumbline-leads.onrender.com';

const db = new Database(dbPath, { readonly: true });

const leads = db.prepare('SELECT * FROM leads').all();
const calls  = db.prepare('SELECT * FROM calls').all();
db.close();

console.log(`Exporting: ${leads.length} leads, ${calls.length} calls`);
console.log(`Destination: ${renderUrl}/api/migrate`);

const body = JSON.stringify({ leads, calls });

const url  = new URL(`${renderUrl}/api/migrate`);
const opts = {
  hostname: url.hostname,
  port:     443,
  path:     url.pathname,
  method:   'POST',
  headers:  {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = https.request(opts, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    if (res.statusCode === 200) {
      const r = JSON.parse(data);
      console.log(`✓ Migration complete: ${r.leadsInserted} leads, ${r.callsInserted} calls inserted`);
      console.log('  REMOVE the /api/migrate endpoint from index.js before next deploy.');
    } else {
      console.error(`✗ HTTP ${res.statusCode}:`, data);
    }
  });
});

req.on('error', err => console.error('Request failed:', err.message));
req.write(body);
req.end();
