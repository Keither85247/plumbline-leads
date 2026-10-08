// ── Gmail connection return handling ─────────────────────────────────────────
// Imported FIRST by main.jsx so it runs before any other module can read or log
// the page URL (and before Sentry starts). The backend returns from Google with
// a single-use completion handle in the URL FRAGMENT (#gmail_complete=…), which
// browsers never send to a server. This module:
//   • always removes that fragment from the address bar immediately,
//   • keeps a well-formed handle in memory only (never storage, never logged),
//   • ignores it when the page is framed (it can only be claimed top-level).
// The signed-in user must still explicitly confirm the connection
// (GmailConnectionView); nothing is completed automatically.

const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
const ERROR_RE  = /^[a-z_]{1,40}$/;

let handle      = null;
let handleSeen  = false;
let gmailError  = null;

if (typeof window !== 'undefined') {
  try {
    const hash = window.location.hash || '';
    if (hash.indexOf('gmail_complete') !== -1) {
      handleSeen = true;
      const value = new URLSearchParams(hash.slice(1)).get('gmail_complete');
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      if (window.top === window.self && typeof value === 'string' && HANDLE_RE.test(value)) handle = value;
    }
    const err = new URLSearchParams(window.location.search).get('gmail_error');
    if (err && ERROR_RE.test(err)) gmailError = err;
  } catch { /* never block app start */ }
}

/** True when this page load is a return from the Gmail connection flow. */
export function hasGmailReturn() { return handleSeen || !!gmailError; }

/** True when the page was opened with a completion handle (valid or not). */
export function sawGmailHandle() { return handleSeen; }

/** The captured handle (memory only), or null. */
export function getGmailHandle() { return handle; }

/** Forget the handle once it has been used or abandoned. */
export function clearGmailHandle() { handle = null; }

/** Error code from ?gmail_error=, if any (the param stays for EmailPage). */
export function getGmailError() { return gmailError; }

/** Remove ?gmail_error= from the address bar. */
export function clearGmailError() {
  gmailError = null;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('gmail_error');
    window.history.replaceState(window.history.state, '', url.pathname + (url.search || ''));
  } catch { /* ignore */ }
}

/** Strip the query string and fragment (session tokens in media URLs, the
 *  Gmail completion handle) from a string bound for Sentry. */
export function scrubUrl(u) {
  if (typeof u !== 'string') return u;
  return u.split(/[?#]/)[0].replace(/gmail_complete=[^&\s]*/g, 'gmail_complete=[removed]');
}
