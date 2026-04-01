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

// Incoming call log — one row per inbound call, written before routing decision.
// transcript/summary/key_points are populated after an answered call recording is processed.
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    call_sid TEXT,
    classification TEXT NOT NULL DEFAULT 'Unknown',
    status TEXT NOT NULL DEFAULT 'incoming',
    recording_url TEXT,
    duration INTEGER,
    transcript TEXT,
    summary TEXT,
    key_points TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Safe migrations for calls table
try { db.exec('ALTER TABLE calls ADD COLUMN recording_url TEXT'); } catch {}
try { db.exec('ALTER TABLE calls ADD COLUMN duration INTEGER'); } catch {}
try { db.exec('ALTER TABLE calls ADD COLUMN transcript TEXT'); } catch {}
try { db.exec('ALTER TABLE calls ADD COLUMN summary TEXT'); } catch {}
try { db.exec('ALTER TABLE calls ADD COLUMN key_points TEXT'); } catch {}
// contractor_note: manually written by the contractor after an outbound call ends.
// Separate from `summary` which is AI-generated for inbound answered calls.
try { db.exec('ALTER TABLE calls ADD COLUMN contractor_note TEXT'); } catch {}
// outcome: call result set by contractor after an outbound call ends.
// Values: 'answered' | 'voicemail' | 'no-answer' | null (null = unknown/not yet set)
try { db.exec('ALTER TABLE calls ADD COLUMN outcome TEXT'); } catch {}

// Add columns to existing databases that predate these fields
try { db.exec('ALTER TABLE leads ADD COLUMN raw_text TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN follow_up_text TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN phone_number TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN category TEXT NOT NULL DEFAULT \'Lead\''); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN callback_number TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN company_name TEXT'); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE leads ADD COLUMN source TEXT NOT NULL DEFAULT 'voicemail'"); } catch {}
try { db.exec('ALTER TABLE leads ADD COLUMN recording_url TEXT'); } catch {}

// Contact profiles — manually-editable data keyed by normalized phone number.
// Separate from leads/calls because profile data (address, email, notes) is
// entered by the contractor, not inferred from AI or Twilio.
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    phone                   TEXT PRIMARY KEY,
    address                 TEXT,
    email                   TEXT,
    notes                   TEXT,
    preferred_contact_method TEXT,
    updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Structured address fields added to contacts for Mapbox Address Autofill integration
try { db.exec('ALTER TABLE contacts ADD COLUMN formatted_address TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN address_line_1 TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN city TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN state TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN postal_code TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN country TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN lat REAL'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN lng REAL'); } catch {}

module.exports = db;
