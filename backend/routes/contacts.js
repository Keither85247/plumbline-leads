const express = require('express');
const db = require('../db');

const router = express.Router();

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
      phone, address, email, notes, preferred_contact_method,
      formatted_address, address_line_1, city, state, postal_code, country, lat, lng,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
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
