const Database = require('better-sqlite3');
const path = require('path');

// DB_PATH can be set to a persistent disk mount path (e.g. /data/leads.db on Render).
// Falls back to the legacy location alongside the source files for local dev.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'leads.db');
const db = new Database(dbPath);

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

// Email activity log — one row per inbound or outbound email event.
// Actual sending/receiving is handled by an external provider (see Phase 2).
// This table stores metadata so emails appear in the timeline and contact history.
db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    phone        TEXT,
    direction    TEXT NOT NULL DEFAULT 'outbound',
    from_address TEXT,
    to_address   TEXT,
    subject      TEXT,
    body_preview TEXT,
    status       TEXT NOT NULL DEFAULT 'sent',
    external_id  TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Contact name — contractor-editable, takes precedence over AI-extracted names from leads
try { db.exec('ALTER TABLE contacts ADD COLUMN name TEXT'); } catch {}

// Structured address fields added to contacts for Mapbox Address Autofill integration
try { db.exec('ALTER TABLE contacts ADD COLUMN formatted_address TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN address_line_1 TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN city TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN state TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN postal_code TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN country TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN lat REAL'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN lng REAL'); } catch {}

// Gmail OAuth tokens — single row for the connected account.
// refresh_token is stored once at connect time; access_token is refreshed automatically.
db.exec(`
  CREATE TABLE IF NOT EXISTS gmail_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL,
    access_token  TEXT    NOT NULL,
    refresh_token TEXT,
    expiry_date   INTEGER,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Gmail-specific fields on emails — added safely so existing rows are unaffected
try { db.exec('ALTER TABLE emails ADD COLUMN gmail_message_id TEXT'); } catch {}
try { db.exec('ALTER TABLE emails ADD COLUMN thread_id TEXT'); } catch {}

// Email state fields — is_read defaults to 1 (read) so historical rows appear read.
// New inbound emails from the poller are inserted with is_read = 0.
try { db.exec('ALTER TABLE emails ADD COLUMN is_read INTEGER NOT NULL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE emails ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE emails ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0'); } catch {}

// Gmail mailbox/label metadata.
// labels_json: JSON-serialised array of Gmail label IDs, e.g. ["INBOX","UNREAD"].
// mailbox: normalised bucket derived from labels — inbox | sent | trash | spam | other.
try { db.exec("ALTER TABLE emails ADD COLUMN labels_json TEXT"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN mailbox TEXT NOT NULL DEFAULT 'inbox'"); } catch {}

// One-time data fix: outbound emails that were imported before the mailbox column
// existed all defaulted to 'inbox'. Correct them to 'sent'.
db.prepare(
  "UPDATE emails SET mailbox = 'sent' WHERE direction = 'outbound' AND mailbox = 'inbox' AND labels_json IS NULL"
).run();

// Attachment metadata stored as a JSON array: [{filename, mime_type, size}].
// Binary content is never stored — attachments are only held in memory during send.
try { db.exec("ALTER TABLE emails ADD COLUMN attachments_json TEXT"); } catch {}

// SMS messages — one row per inbound or outbound text message.
// `phone` is the customer's number (normalized to E.164 or 10-digit).
// `direction`: 'inbound' | 'outbound'
// `status`: 'sent' | 'delivered' | 'failed' | 'received'
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    phone        TEXT    NOT NULL,
    direction    TEXT    NOT NULL DEFAULT 'outbound',
    body         TEXT    NOT NULL,
    twilio_sid   TEXT,
    status       TEXT    NOT NULL DEFAULT 'sent',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Link messages to their parent lead for thread-to-lead attachment
try { db.exec('ALTER TABLE messages ADD COLUMN lead_id INTEGER REFERENCES leads(id)'); } catch {}
// Read tracking — is_read = 1 once the contractor opens the conversation
try { db.exec('ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0'); } catch {}
// Seen tracking for missed calls — is_seen = 1 once the contractor views the Recent list
try { db.exec('ALTER TABLE calls ADD COLUMN is_seen INTEGER NOT NULL DEFAULT 0'); } catch {}
// MMS support — JSON array of media URLs (outbound: our CDN path; inbound: Twilio CDN URLs)
try { db.exec('ALTER TABLE messages ADD COLUMN media_urls TEXT'); } catch {}

// ── User accounts ─────────────────────────────────────────────────────────────
// One row per contractor account. password_hash stored as bcrypt.
// api_key kept for potential CLI/tester use (not used by session auth).

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    display_name  TEXT,
    api_key       TEXT    UNIQUE,
    password_hash TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
// Safe migration: add password_hash to existing users table
try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch {}

// ── Sessions ──────────────────────────────────────────────────────────────────
// One row per active login. Token is a 32-byte random hex string stored in an
// httpOnly cookie. Rows are invalidated by deleting them (logout) or by
// expires_at passing (checked on every protected request).

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at DATETIME NOT NULL
  )
`);

// ── user_id scaffolding on data tables ────────────────────────────────────────
// All nullable so existing rows stay intact (NULL = legacy / pre-auth row).
// Row-level scoping is enforced in route handlers via (user_id = ? OR user_id IS NULL).
// Once all legacy data is claimed (create-user.js --assign), remove the NULL clause.

try { db.exec('ALTER TABLE leads    ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE calls    ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE emails   ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE gmail_tokens ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}

// ── Contacts table migration ───────────────────────────────────────────────────
// Old schema: phone TEXT PRIMARY KEY — globally unique, blocks multi-user.
// New schema: UNIQUE(user_id, phone) — each user can save the same phone number.
// Runs once; safe to re-deploy (the regex check prevents re-running).
try {
  const tableInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'"
  ).get();

  // Only migrate if the old PRIMARY KEY declaration is still present
  if (tableInfo && /phone\s+TEXT\s+PRIMARY\s+KEY/i.test(tableInfo.sql)) {
    db.exec(`
      CREATE TABLE contacts_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                  INTEGER REFERENCES users(id),
        phone                    TEXT    NOT NULL,
        name                     TEXT,
        address                  TEXT,
        email                    TEXT,
        notes                    TEXT,
        preferred_contact_method TEXT,
        formatted_address        TEXT,
        address_line_1           TEXT,
        city                     TEXT,
        state                    TEXT,
        postal_code              TEXT,
        country                  TEXT,
        lat                      REAL,
        lng                      REAL,
        updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, phone)
      );
      INSERT INTO contacts_new
        (user_id, phone, name, address, email, notes, preferred_contact_method,
         formatted_address, address_line_1, city, state, postal_code, country,
         lat, lng, updated_at)
      SELECT
        user_id, phone, name, address, email, notes, preferred_contact_method,
        formatted_address, address_line_1, city, state, postal_code, country,
        lat, lng, updated_at
      FROM contacts;
      DROP TABLE contacts;
      ALTER TABLE contacts_new RENAME TO contacts;
    `);
    console.log('[DB] Contacts table migrated to per-user uniqueness');
  }
} catch (err) {
  console.error('[DB] Contacts migration error:', err.message);
}

module.exports = db;
