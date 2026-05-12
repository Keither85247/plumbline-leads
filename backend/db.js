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
    is_owner      INTEGER NOT NULL DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
// Safe migrations: add columns to existing users table
try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0'); } catch {}
// Tester account suspension — owner can flip this to 1 to block all activity
try { db.exec('ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN business_name TEXT'); } catch {}
// Access/subscription status — drives the paywall gate after login
// Values: 'unknown' (default) | 'tester' | 'trial' | 'active' | 'blocked'
// Owners are always treated as 'owner' regardless of this column.
try { db.exec("ALTER TABLE users ADD COLUMN access_status TEXT NOT NULL DEFAULT 'unknown'"); } catch {}

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
// All nullable so existing rows stay intact on first migration.
// Legacy rows (user_id IS NULL) are stamped to the owner account below so that
// route handlers can filter strictly by user_id without the OR IS NULL escape hatch.

try { db.exec('ALTER TABLE leads    ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE calls    ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE emails   ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE gmail_tokens ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}

// ── Stamp legacy NULL rows to the owner account ───────────────────────────────
// Runs on every boot but is a no-op once rows are stamped.
// Without this, every user sees the owner's historical data because pre-multi-user
// rows have user_id = NULL and queries used (user_id = ? OR user_id IS NULL).
try {
  const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1').get();
  if (owner) {
    const stamp = db.transaction(() => {
      const r1 = db.prepare('UPDATE leads        SET user_id = ? WHERE user_id IS NULL').run(owner.id);
      const r2 = db.prepare('UPDATE calls        SET user_id = ? WHERE user_id IS NULL').run(owner.id);
      const r3 = db.prepare('UPDATE emails       SET user_id = ? WHERE user_id IS NULL').run(owner.id);
      const r4 = db.prepare('UPDATE messages     SET user_id = ? WHERE user_id IS NULL').run(owner.id);
      const r5 = db.prepare('UPDATE contacts     SET user_id = ? WHERE user_id IS NULL').run(owner.id);
      // Gmail tokens without a user_id belong to the owner (pre-multi-user tokens)
      const r6 = db.prepare('UPDATE gmail_tokens SET user_id = ? WHERE user_id IS NULL').run(owner.id);
      return r1.changes + r2.changes + r3.changes + r4.changes + r5.changes + r6.changes;
    });
    const total = stamp();
    if (total > 0) console.log(`[DB] Stamped ${total} legacy rows → owner user_id=${owner.id}`);
  }
} catch (err) {
  console.error('[DB] Legacy row stamp failed:', err.message);
}

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

// ── Allow contacts.phone to be NULL ──────────────────────────────────────────
// Manual contacts added by the user may not have a phone number.
// The previous schema had phone TEXT NOT NULL; recreate to remove the constraint.
// SQLite's UNIQUE constraint treats NULL values as distinct, so multiple
// phone-less rows per user are allowed (each gets its own row).
try {
  const tbl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'"
  ).get();
  // Only run if phone column still has NOT NULL constraint
  if (tbl && /phone\s+TEXT\s+NOT\s+NULL/i.test(tbl.sql)) {
    db.exec(`
      CREATE TABLE contacts_v3 (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                  INTEGER REFERENCES users(id),
        phone                    TEXT,
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
      INSERT INTO contacts_v3
        (id, user_id, phone, name, address, email, notes, preferred_contact_method,
         formatted_address, address_line_1, city, state, postal_code, country,
         lat, lng, updated_at)
      SELECT
        id, user_id, phone, name, address, email, notes, preferred_contact_method,
        formatted_address, address_line_1, city, state, postal_code, country,
        lat, lng, updated_at
      FROM contacts;
      DROP TABLE contacts;
      ALTER TABLE contacts_v3 RENAME TO contacts;
    `);
    console.log('[DB] Contacts phone made nullable (supports manual contacts without phone)');
  }
} catch (err) {
  console.error('[DB] Contacts phone-nullable migration error:', err.message);
}

// Company and contact_type for manually-created contacts
try { db.exec('ALTER TABLE contacts ADD COLUMN company TEXT'); } catch {}
try { db.exec("ALTER TABLE contacts ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'Lead'"); } catch {}

// ── App-wide settings ─────────────────────────────────────────────────────────
// Simple key/value store for non-tenant data only (e.g. gmail_last_poll_time).
// MUST NOT be used for anything user-facing — see voicemail_greetings below.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )
`);

// ── Per-user voicemail greetings ──────────────────────────────────────────────
// Strictly per-tenant. One row per user; missing row = fall back to default TTS.
// public_token is a random hex string that authorizes Twilio's <Play> verb to
// fetch the audio without a session cookie. Token rotates on every upload so a
// leaked URL is invalidated immediately when the user re-records.
db.exec(`
  CREATE TABLE IF NOT EXISTS voicemail_greetings (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    type         TEXT NOT NULL DEFAULT 'tts',
    tts_text     TEXT,
    audio_file   TEXT,
    public_token TEXT UNIQUE,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Migration: legacy global voicemail greeting → owner's per-user row ────────
// Pre-fix the greeting lived in app_settings (global). We attribute the existing
// data to the owner account and move the audio file into the owner's per-user
// directory. After migration the legacy app_settings keys are deleted so no
// other user can ever read them.
try {
  const legacyType = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting_type'").get()?.value;
  const legacyFile = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting_file'").get()?.value;
  const legacyText = db.prepare("SELECT value FROM app_settings WHERE key = 'voicemail_greeting'").get()?.value;

  if (legacyType || legacyFile || legacyText) {
    const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1').get()
                ?? db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

    if (owner) {
      const existing = db.prepare('SELECT user_id FROM voicemail_greetings WHERE user_id = ?').get(owner.id);
      if (!existing) {
        const fs    = require('fs');
        const path  = require('path');
        const crypto = require('crypto');
        const { getDataDir } = require('./utils/dataDir');

        const dataDir = getDataDir();
        let newAudioFile = null;

        if (legacyFile) {
          const oldPath = path.join(dataDir, legacyFile);
          if (fs.existsSync(oldPath)) {
            const ext         = path.extname(legacyFile).toLowerCase();
            const userDir     = path.join(dataDir, 'voicemail_greetings', `user_${owner.id}`);
            const uuid        = crypto.randomBytes(16).toString('hex');
            const newFilename = `greeting_${uuid}${ext}`;
            const newPath     = path.join(userDir, newFilename);

            fs.mkdirSync(userDir, { recursive: true });
            fs.renameSync(oldPath, newPath);
            newAudioFile = newFilename;
            console.log(`[DB] Migrated legacy voicemail greeting → ${newPath}`);
          }
        }

        db.prepare(`
          INSERT INTO voicemail_greetings (user_id, type, tts_text, audio_file, public_token)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          owner.id,
          (legacyType === 'audio' && newAudioFile) ? 'audio' : 'tts',
          legacyText || null,
          newAudioFile,
          crypto.randomBytes(32).toString('hex')
        );

        console.log(`[DB] Legacy voicemail greeting attributed to owner user_id=${owner.id}`);
      }
    }

    // Always remove legacy keys so no future read can leak them across tenants
    db.prepare("DELETE FROM app_settings WHERE key IN ('voicemail_greeting','voicemail_greeting_type','voicemail_greeting_file')").run();
    console.log('[DB] Legacy global voicemail keys removed from app_settings');
  }
} catch (err) {
  console.error('[DB] Voicemail greeting migration error:', err.message);
}

// ── Per-user Twilio phone numbers ─────────────────────────────────────────────
// One row per purchased Twilio number. assigned_user_id is nullable (unassigned).
// Inbound call/SMS routing reads this table to determine which user owns a number.
db.exec(`
  CREATE TABLE IF NOT EXISTS phone_numbers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number     TEXT    NOT NULL UNIQUE,
    twilio_sid       TEXT    NOT NULL UNIQUE,
    friendly_name    TEXT,
    assigned_user_id INTEGER REFERENCES users(id),
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
// Number-level suspension — disables inbound + outbound for this specific number
// without touching the user account itself.
try { db.exec('ALTER TABLE phone_numbers ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0'); } catch {}

// ── FCM subscriptions (Android Capacitor app) ─────────────────────────────────
// One row per device. token is the FCM registration token.
// Stale tokens are pruned when Firebase returns a registration error.
db.exec(`
  CREATE TABLE IF NOT EXISTS fcm_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id),
    fcm_token  TEXT    NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Web Push subscriptions ────────────────────────────────────────────────────
// One row per browser/device subscription. endpoint is globally unique.
// Expired or unsubscribed rows are deleted automatically when web-push returns
// a 404 or 410 status on delivery.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id),
    endpoint   TEXT    NOT NULL UNIQUE,
    p256dh     TEXT    NOT NULL,
    auth       TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;
