const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/contacts/search?q=... ─────────────────────────────────────────────
// Full-text search over contacts that have a saved email address.
// Matches against the contact's email AND against the name derived from leads.
// NOTE: must be defined BEFORE the /:phone wildcard route.

router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  // Require at least one character to avoid returning the full list
  if (!q) return res.json([]);

  try {
    // Build a derived table that pairs each contact (with email) with the best
    // name from their most-recent non-unknown lead record. Falls back to the
    // email address itself so the row is always selectable.
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
              ORDER BY l.created_at DESC
              LIMIT 1
            ),
            c.email
          ) AS name
        FROM contacts c
        WHERE c.email IS NOT NULL AND trim(c.email) != ''
      ) t
      WHERE
        instr(lower(t.email), ?) > 0
        OR instr(lower(t.name),  ?) > 0
      ORDER BY t.name ASC
      LIMIT 8
    `).all(q, q);

    res.json(rows);
  } catch (err) {
    console.error('[Contacts] Search failed:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/contacts/:phone — fetch saved profile for a normalized phone number
router.get('/:phone', (req, res) => {
  const { phone } = req.params;
  const row = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  if (!row) return res.json(null);
  res.json(row);
});

// PUT /api/contacts/:phone — upsert full profile including structured address fields
router.put('/:phone', (req, res) => {
  const { phone } = req.params;
  const {
    name,
    // legacy plain text address (kept for backwards compat)
    address,
    email,
    notes,
    preferred_contact_method,
    // structured address fields from Mapbox
    formatted_address,
    address_line_1,
    city,
    state,
    postal_code,
    country,
    lat,
    lng,
  } = req.body;

  db.prepare(`
    INSERT INTO contacts (
      phone, name, address, email, notes, preferred_contact_method,
      formatted_address, address_line_1, city, state, postal_code, country, lat, lng,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      name                     = excluded.name,
      address                  = excluded.address,
      email                    = excluded.email,
      notes                    = excluded.notes,
      preferred_contact_method = excluded.preferred_contact_method,
      formatted_address        = excluded.formatted_address,
      address_line_1           = excluded.address_line_1,
      city                     = excluded.city,
      state                    = excluded.state,
      postal_code              = excluded.postal_code,
      country                  = excluded.country,
      lat                      = excluded.lat,
      lng                      = excluded.lng,
      updated_at               = CURRENT_TIMESTAMP
  `).run(
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

  const row = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  res.json(row);
});

module.exports = router;
