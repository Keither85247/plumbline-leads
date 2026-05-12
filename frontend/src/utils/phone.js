/**
 * Normalize a phone number to 10 digits (US) for consistent matching.
 * Strips all non-digit characters, then removes a leading country code of 1
 * if the result is 11 digits starting with 1.
 * Returns an empty string if the input is falsy or too short to be a real number.
 *
 * Examples:
 *   "+1 (631) 747-7174"  → "6317477174"
 *   "631-747-7174"       → "6317477174"
 *   "6317477174"         → "6317477174"
 *   "+16317477174"       → "6317477174"
 */
/**
 * Parse a timestamp string from the backend into a Date object.
 *
 * SQLite's CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC with no
 * timezone indicator. JavaScript's Date constructor treats strings without
 * a timezone as LOCAL time, causing displayed times to be offset by the
 * user's UTC offset (e.g. 4 hours off for EST).
 *
 * Appending 'Z' forces UTC parsing so displayed times are correct everywhere.
 */
export function parseTimestamp(str) {
  if (!str) return new Date(NaN);
  // Already has timezone info — parse as-is
  if (str.includes('Z') || str.includes('+')) return new Date(str);
  // SQLite space-separated UTC → ISO T-separator + Z for UTC
  return new Date(str.replace(' ', 'T') + 'Z');
}

export function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  // Return as-is if length is unexpected — avoid false negatives
  return digits;
}

/**
 * Strict US/Canada (NANP) check. Returns true only when `raw` represents a
 * sendable North American number; everything else (UK, India, Mexico,
 * incomplete digits, blank, etc.) returns false.
 *
 * Critically, this rejects strings that begin with `+` followed by any
 * country code OTHER than 1. The previous loose check only looked at total
 * digit count — selecting a contact whose phone was '+44 20 7946 0958'
 * passed unchecked into the backend, which then rejected with a generic
 * error and broke the compose flow.
 *
 * Accepts:
 *   "2035551212"
 *   "(203) 555-1212"
 *   "+1 203-555-1212"
 *   "12035551212"
 *   "+12035551212"
 *
 * Rejects:
 *   "+44 20 7946 0958"  (UK)
 *   "+91 9876543210"    (India)
 *   "+52 55 1234 5678"  (Mexico)
 *   "447400123456"      (UK without +)
 *   "203"               (incomplete)
 *   ""                  (blank)
 */
export function isUsCaPhone(raw) {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;

  // Explicit international prefix — only +1 is allowed (NANP).
  if (trimmed.startsWith('+')) {
    const afterPlus = trimmed.slice(1).replace(/\D/g, '');
    return afterPlus.length === 11 && afterPlus.startsWith('1');
  }

  // No + prefix: must be 10 digits, or 11 digits starting with 1.
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return true;
  if (digits.length === 11 && digits.startsWith('1')) return true;
  return false;
}
