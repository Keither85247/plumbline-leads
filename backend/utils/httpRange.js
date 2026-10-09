'use strict';
/**
 * HTTP Range handling for media (single range only).
 *
 * parseRange: accepts exactly "bytes=a-b", "bytes=a-" or "bytes=-n" (digits
 * only, bounded length); anything else — multiple ranges, other units, junk —
 * is ignored (null) and the whole body is served.
 * fileRange:  turns a parsed range into concrete bounds for a file of `total`
 * bytes, or { unsatisfiable: true } (→ 416 with "Content-Range: bytes * /total").
 */

function parseRange(h) {
  if (typeof h !== 'string' || h.length > 64) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] !== '' && m[2] !== '' && Number(m[2]) < Number(m[1])) return null;
  return {
    start:  m[1] === '' ? null : Number(m[1]),
    end:    m[2] === '' ? null : Number(m[2]),
    header: `bytes=${m[1]}-${m[2]}`,
  };
}

function fileRange(range, total) {
  if (!range) return { status: 200, start: 0, end: total - 1 };
  let start;
  let end;
  if (range.start === null) { start = Math.max(0, total - range.end); end = total - 1; }
  else { start = range.start; end = range.end === null ? total - 1 : Math.min(range.end, total - 1); }
  if (total === 0 || start > end || start >= total || (range.start === null && range.end === 0)) {
    return { unsatisfiable: true };
  }
  return { status: 206, start, end };
}

module.exports = { parseRange, fileRange };
