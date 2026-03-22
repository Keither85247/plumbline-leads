const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'leads.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript TEXT NOT NULL,
    raw_text TEXT,
    contact_name TEXT NOT NULL DEFAULT 'Unknown',
    company_name TEXT,
    phone_number TEXT,
    callback_number TEXT,
    summary TEXT NOT NULL,
    key_points TEXT NOT NULL DEFAULT '[]',
    follow_up_text TEXT,
    category TEXT NOT NULL DEFAULT 'Lead',
    status TEXT NOT NULL DEFAULT 'New',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Incoming call log — one row per inbound call, written before routing decision
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    call_sid TEXT,
    classification TEXT NOT NULL DEFAULT 'Unknown',
    status TEXT NOT NULL DEFAULT 'incoming',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add columns to existing databases that predate these fields
try { db.exec('ALTER TABLE leads ADD COLUMN raw_text TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN follow_up_text TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN phone_number TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN category TEXT NOT NULL DEFAULT \'Lead\''); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN callback_number TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN company_name TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch {}

module.exports = db;
