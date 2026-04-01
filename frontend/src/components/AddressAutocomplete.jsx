import { useState, useEffect } from 'react';
import { AddressAutofill } from '@mapbox/search-js-react';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

/**
 * Proximity resolution (highest priority wins):
 *
 *  1. VITE_CONTRACTOR_LAT / VITE_CONTRACTOR_LNG  — set in .env per contractor
 *  2. browser geolocation                         — requested once, silently ignored if denied
 *  3. nothing                                     — Mapbox falls back to IP-based location
 *
 * `proximity` is a relevance *bias*, not a hard filter. Out-of-area addresses
 * remain selectable whenever the typed query clearly matches them.
 */
const CONFIG_PROXIMITY = (() => {
  const lat = parseFloat(import.meta.env.VITE_CONTRACTOR_LAT);
  const lng = parseFloat(import.meta.env.VITE_CONTRACTOR_LNG);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
})();

/**
 * AddressAutocomplete — street-address field with local-biased Mapbox autocomplete.
 *
 * Only the street line (address_line1) appears in the input.
 * City / state / zip are returned via onSelect and rendered by the parent.
 *
 * Props:
 *   value       string  — controlled value (address_line_1)
 *   onChange    fn(str) — called on every keystroke
 *   onSelect    fn(obj) — called when a suggestion is chosen; receives:
 *                         { address_line_1, city, state, postal_code,
 *                           country, formatted_address, lat, lng }
 *   placeholder string
 */
export default function AddressAutocomplete({
  value = '',
  onChange,
  onSelect,
  placeholder = '123 Main St',
}) {
  // Start with the contractor config coords.
  // If not configured, try browser geolocation asynchronously.
  const [proximity, setProximity] = useState(CONFIG_PROXIMITY);

  useEffect(() => {
    if (CONFIG_PROXIMITY) return; // config coords take priority — skip geolocation
    if (!navigator?.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      pos => setProximity({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      ()  => { /* denied or unavailable — Mapbox uses IP-based location */ },
      { timeout: 4000, maximumAge: 5 * 60 * 1000 },
    );
  }, []);

  function handleRetrieve(res) {
    const feat = res?.features?.[0];
    if (!feat) return;

    const p      = feat.properties ?? {};
    const coords = feat.geometry?.coordinates; // [lng, lat]

    const structured = {
      address_line_1:    p.address_line1 ?? p.address ?? '',
      city:              p.place         ?? '',
      state:             p.region_code   ?? p.region ?? '',
      postal_code:       p.postcode      ?? '',
      country:           p.country       ?? '',
      formatted_address: p.full_address  ?? p.place_name ?? '',
      lat: coords ? coords[1] : null,
      lng: coords ? coords[0] : null,
    };

    // Show only the street line inside the input after selection
    onChange?.(structured.address_line_1);
    onSelect?.(structured);
  }

  const autofillOptions = {
    country: 'US',
    ...(proximity && { proximity }),
  };

  return (
    <AddressAutofill
      accessToken={MAPBOX_TOKEN}
      onRetrieve={handleRetrieve}
      options={autofillOptions}
    >
      <input
        type="text"
        autoComplete="address-line1"
        value={value}
        onChange={e => onChange?.(e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400"
      />
    </AddressAutofill>
  );
}
