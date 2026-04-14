const express = require('express');
const db = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/contacts
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM contacts WHERE (user_id = ? OR user_id IS NULL) ORDER BY updated_at DESC'
    ).all(req.userId);
    res.json(rows);
  } catch (err) {
    console.error('[Contacts] GET / failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contacts/search?q=...
// Must be defined BEFORE the /:phone wildcard route.
// ---------------------------------------------------------------------------
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  try {
    const rows = db.prepare(`
      SELECT t.phone, t.email, t.name
      FROM (
        SELECT
          c.phone,
          c.email,
          COALESCE(
            (
              SELECT l.contact_name
              FROM leads l
              WHERE
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  COALESCE(l.callback_number, l.phone_number, ''),
                  '+',''),'-',''),' ',''),'(',''),')','') = c.phone
                AND l.contact_name != 'Unknown'
                AND (l.user_id = ? OR l.user_id IS NULL)
              ORDER BY l.created_at DESC
              LIMIT 1
            ),
            c.email
          ) AS name
        FROM contacts c
        WHERE c.email IS NOT NULL AND trim(c.email) != ''
          AND (c.user_id = ? OR c.user_id IS NULL)
      ) t
      WHERE
        instr(lower(t.email), ?) > 0
        OR instr(lower(t.name),  ?) > 0
      ORDER BY t.name ASC
      LIMIT 8
    `).all(req.userId, req.userId, q, q);

    res.json(rows);
  } catch (err) {
    console.error('[Contacts] Search failed:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/contacts/:phone
// ---------------------------------------------------------------------------
router.get('/:phone', (req, res) => {
  const { phone } = req.params;
  const row = db.prepare(
    'SELECT * FROM contacts WHERE phone = ? AND (user_id = ? OR user_id IS NULL)'
  ).get(phone, req.userId);
  if (!row) return res.json(null);
  res.json(row);
});

// ---------------------------------------------------------------------------
// PUT /api/contacts/:phone
// Upsert: if a row for this (user, phone) pair exists, update it; else insert.
// Also claims ownership of any legacy NULL user_id row for this phone.
// ---------------------------------------------------------------------------
router.put('/:phone', (req, res) => {
  const { phone }  = req.params;
  const userId     = req.userId;
  const {
    name,
    address,
    email,
    notes,
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
    // Find an existing row this user owns or a legacy (NULL) row to claim
    const existing = db.prepare(
      'SELECT id FROM contacts WHERE phone = ? AND (user_id = ? OR user_id IS NULL) LIMIT 1'
    ).get(phone, userId);

    if (existing) {
      // Update in place — also stamps user_id so the NULL row becomes owned
      db.prepare(`
        UPDATE contacts SET
          user_id                  = ?,
          name                     = ?,
          address                  = ?,
          email                    = ?,
          notes                    = ?,
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
      // No existing row — insert a fresh one for this user
      db.prepare(`
        INSERT INTO contacts
          (user_id, phone, name, address, email, notes, preferred_contact_method,
           formatted_address, address_line_1, city, state, postal_code, country,
           lat, lng, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        userId,
        phone,
        name               || null,
        address            || null,
        email              || null,
        notes              || null,
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

module.exports = router;
