'use strict';
const express = require('express');
const db      = require('../db');

const router = express.Router();

// Normalise a phone string to digits only (US: strip leading 1 from 11-digit).
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// ---------------------------------------------------------------------------
// GET /api/contacts
// Returns all saved contact profiles for the authenticated user.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM contacts WHERE user_id = ? ORDER BY updated_at DESC'
    ).all(req.userId);
    res.json(rows);
  } catch (err) {
    console.error('[Contacts] GET / failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contacts/search?q=...
// Full-text search over name, phone, email, company for this user.
// Must be defined BEFORE the /:phone wildcard route.
// ---------------------------------------------------------------------------
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  try {
    // Search across contacts table fields
    const fromContacts = db.prepare(`
      SELECT
        c.id,
        c.phone,
        c.email,
        c.name,
        c.company,
        c.contact_type
      FROM contacts c
      WHERE c.user_id = ?
        AND (
          instr(lower(COALESCE(c.name,    '')), ?) > 0
          OR instr(lower(COALESCE(c.email,   '')), ?) > 0
          OR instr(lower(COALESCE(c.company, '')), ?) > 0
          OR instr(COALESCE(c.phone, ''), ?)        > 0
        )
      ORDER BY c.updated_at DESC
      LIMIT 10
    `).all(req.userId, q, q, q, q);

    // Also surface contacts from leads that haven't been profiled yet
    const fromLeads = db.prepare(`
      SELECT DISTINCT
        NULL          AS id,
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          COALESCE(l.callback_number, l.phone_number, ''),
          '+',''),'-',''),' ',''),'(',''),')','') AS phone,
        NULL          AS email,
        l.contact_name AS name,
        l.company_name AS company,
        l.category     AS contact_type
      FROM leads l
      WHERE l.user_id = ?
        AND l.contact_name != 'Unknown'
        AND (
          instr(lower(l.contact_name), ?) > 0
          OR instr(lower(COALESCE(l.company_name, '')), ?) > 0
          OR instr(COALESCE(l.phone_number, l.callback_number, ''), ?) > 0
        )
      ORDER BY l.created_at DESC
      LIMIT 10
    `).all(req.userId, q, q, q);

    // Merge, dedupe by phone
    const seen  = new Set();
    const merged = [];
    for (const row of [...fromContacts, ...fromLeads]) {
      const key = row.phone || `id:${row.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(row);
      }
    }

    res.json(merged.slice(0, 10));
  } catch (err) {
    console.error('[Contacts] Search failed:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contacts
// Create a new manual contact. Requires at least one of: name, phone, email.
// ---------------------------------------------------------------------------
router.post('/', express.json(), (req, res) => {
  const userId = req.userId;
  const {
    name,
    phone,
    email,
    company,
    notes,
    contact_type = 'Lead',
  } = req.body || {};

  const trimName    = (name    || '').trim();
  const trimEmail   = (email   || '').trim().toLowerCase();
  const trimCompany = (company || '').trim();
  const trimNotes   = (notes   || '').trim();

  const normalizedPhone = normalizePhone(phone);

  // Require at least one identifying field
  if (!trimName && !normalizedPhone && !trimEmail) {
    return res.status(400).json({ error: 'Enter at least a name, phone, or email.' });
  }

  // Email format check
  if (trimEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  // Duplicate phone check (within this user's contacts)
  if (normalizedPhone) {
    const existing = db.prepare(
      'SELECT id FROM contacts WHERE user_id = ? AND phone = ?'
    ).get(userId, normalizedPhone);
    if (existing) {
      return res.status(409).json({ error: 'A contact with this phone number already exists.' });
    }
  }

  const validTypes = ['Lead', 'Customer', 'Vendor', 'Supplier'];
  const safeType   = validTypes.includes(contact_type) ? contact_type : 'Lead';

  try {
    const result = db.prepare(`
      INSERT INTO contacts
        (user_id, phone, name, email, company, notes, contact_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      userId,
      normalizedPhone || null,
      trimName        || null,
      trimEmail       || null,
      trimCompany     || null,
      trimNotes       || null,
      safeType,
    );

    const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
    console.log(`[Contacts] Created contact id=${row.id} for user ${userId}: "${trimName || trimEmail || normalizedPhone}" (${safeType})`);
    res.status(201).json(row);
  } catch (err) {
    console.error('[Contacts] POST failed:', err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// ---------------------------------------------------------------------------
// Contact hides — per-user "remove from list" for phone-only contacts.
//
// The Contacts screen merges three sources (leads / calls / saved profiles)
// into one virtual list. The DELETE /:id route below handles the profile-
// backed rows; this hide list handles everything else. A hide is a phone-
// based marker that the frontend uses to filter the merged list.
//
// Endpoints (mounted at /api/contacts):
//   GET    /hidden             → ["3034567890", ...] phones the user hid
//   POST   /hide  { phone }    → upsert a hide row
//   DELETE /hide/:phone        → remove (unhide)
//
// CRITICAL ROUTE ORDER: these MUST be declared before the GET /:phone and
// DELETE /:id wildcards. Express matches in declaration order, so without
// the early position GET /hidden would resolve to GET /:phone with
// phone="hidden" (returning null), and DELETE /hide/:phone would never
// reach this handler because /:id would match first.
// ---------------------------------------------------------------------------

function normalizePhoneIn(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

router.get('/hidden', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT phone FROM contact_hides WHERE user_id = ?'
    ).all(req.userId);
    res.json(rows.map(r => r.phone));
  } catch (err) {
    console.error('[Contacts] GET /hidden failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch hidden contacts' });
  }
});

router.post('/hide', express.json(), (req, res) => {
  try {
    const phone = normalizePhoneIn(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });
    db.prepare(`
      INSERT INTO contact_hides (user_id, phone)
      VALUES (?, ?)
      ON CONFLICT(user_id, phone) DO NOTHING
    `).run(req.userId, phone);
    res.json({ ok: true, phone });
  } catch (err) {
    console.error('[Contacts] POST /hide failed:', err.message);
    res.status(500).json({ error: 'Failed to hide contact' });
  }
});

router.delete('/hide/:phone', (req, res) => {
  try {
    const phone = normalizePhoneIn(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });
    db.prepare(
      'DELETE FROM contact_hides WHERE user_id = ? AND phone = ?'
    ).run(req.userId, phone);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Contacts] DELETE /hide failed:', err.message);
    res.status(500).json({ error: 'Failed to unhide contact' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contacts/:phone
// ---------------------------------------------------------------------------
router.get('/:phone', (req, res) => {
  const { phone } = req.params;
  const row = db.prepare(
    'SELECT * FROM contacts WHERE phone = ? AND user_id = ?'
  ).get(phone, req.userId);
  if (!row) return res.json(null);
  res.json(row);
});

// ---------------------------------------------------------------------------
// PUT /api/contacts/:phone
// Upsert: if a row for this (user, phone) pair exists, update it; else insert.
// ---------------------------------------------------------------------------
router.put('/:phone', express.json(), (req, res) => {
  const { phone }  = req.params;
  const userId     = req.userId;
  const {
    name,
    address,
    email,
    notes,
    company,
    contact_type,
    preferred_contact_method,
    formatted_address,
    address_line_1,
    city,
    state,
    postal_code,
    country,
    lat,
    lng,
  } = req.body;

  try {
    const existing = db.prepare(
      'SELECT id FROM contacts WHERE phone = ? AND user_id = ? LIMIT 1'
    ).get(phone, userId);

    if (existing) {
      db.prepare(`
        UPDATE contacts SET
          user_id                  = ?,
          name                     = ?,
          address                  = ?,
          email                    = ?,
          notes                    = ?,
          company                  = ?,
          contact_type             = COALESCE(?, contact_type),
          preferred_contact_method = ?,
          formatted_address        = ?,
          address_line_1           = ?,
          city                     = ?,
          state                    = ?,
          postal_code              = ?,
          country                  = ?,
          lat                      = ?,
          lng                      = ?,
          updated_at               = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        userId,
        name               || null,
        address            || null,
        email              || null,
        notes              || null,
        company            || null,
        contact_type       || null,
        preferred_contact_method || null,
        formatted_address  || null,
        address_line_1     || null,
        city               || null,
        state              || null,
        postal_code        || null,
        country            || null,
        lat                ?? null,
        lng                ?? null,
        existing.id,
      );
    } else {
      db.prepare(`
        INSERT INTO contacts
          (user_id, phone, name, address, email, notes, company, contact_type,
           preferred_contact_method, formatted_address, address_line_1,
           city, state, postal_code, country, lat, lng, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        userId,
        phone,
        name               || null,
        address            || null,
        email              || null,
        notes              || null,
        company            || null,
        contact_type       || 'Lead',
        preferred_contact_method || null,
        formatted_address  || null,
        address_line_1     || null,
        city               || null,
        state              || null,
        postal_code        || null,
        country            || null,
        lat                ?? null,
        lng                ?? null,
      );
    }

    const row = db.prepare(
      'SELECT * FROM contacts WHERE phone = ? AND user_id = ?'
    ).get(phone, userId);
    res.json(row);
  } catch (err) {
    console.error('[Contacts] PUT failed:', err.message);
    res.status(500).json({ error: 'Failed to save contact' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/contacts/:id
// Removes the contact profile row. Calls, messages, and leads that reference
// the same phone number are NOT touched — they continue to surface as
// "Unknown" the next time they're rendered (matching iPhone behavior where
// deleting a contact doesn't wipe call history).
//
// Returns 404 (not 403) when the contact belongs to another user, so we
// don't leak ownership information across accounts.
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    const result = db.prepare(
      'DELETE FROM contacts WHERE id = ? AND user_id = ?'
    ).run(id, req.userId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Contacts] DELETE failed:', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;
