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
export function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  // Return as-is if length is unexpected — avoid false negatives
  return digits;
}
