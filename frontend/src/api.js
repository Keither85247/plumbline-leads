// In local dev (VITE_BACKEND_URL not set): relative paths → proxied by Vite to localhost:3001
// In production (VITE_BACKEND_URL=https://your-backend.onrender.com): absolute cross-origin URLs
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';
export const API_BASE    = `${BACKEND_URL}/api`;
export const AUTH_BASE   = `${BACKEND_URL}/auth`;

import * as Sentry from '@sentry/react';

/**
 * Thin fetch wrapper that:
 *  1. Always sends credentials (session cookie) — required for cross-origin requests
 *     between the Vercel frontend and the Render backend.
 *  2. Reports unexpected non-2xx responses and network errors to Sentry.
 *
 * Uses globalThis.fetch internally so renaming fetch→apiFetch in this file
 * doesn't cause infinite recursion.
 *
 * @param {string}   url
 * @param {object}   options        Standard fetch options
 * @param {number[]} options.skipSentryOn  HTTP status codes NOT to report to Sentry.
 *                                         Use for expected non-2xx (e.g. 401 from /auth/me).
 */
async function apiFetch(url, options = {}) {
  const { skipSentryOn = [], ...fetchOptions } = options;
  try {
    const res = await globalThis.fetch(url, {
      credentials: 'include',   // send session cookie on every request
      ...fetchOptions,
    });
    if (!res.ok && !skipSentryOn.includes(res.status)) {
      Sentry.captureException(
        new Error(`${fetchOptions.method || 'GET'} ${url} → HTTP ${res.status}`),
        { extra: { url, status: res.status, method: fetchOptions.method || 'GET' } }
      );
    }
    return res;
  } catch (networkErr) {
    // Covers: CORS block (wildcard origin + credentials), backend down, no network
    Sentry.captureException(networkErr, { extra: { url, method: fetchOptions.method || 'GET' } });
    throw networkErr;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Log in with email + password.
 * On success the backend sets an httpOnly session cookie — no token to store.
 * @returns {{ id: number, email: string, display_name: string }}
 */
export async function login(email, password) {
  // 401 means wrong password — expected, not an error worth sending to Sentry
  const res = await apiFetch(`${AUTH_BASE}/login`, {
    method:       'POST',
    headers:      { 'Content-Type': 'application/json' },
    body:         JSON.stringify({ email, password }),
    skipSentryOn: [401],
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Login failed');
  }
  return res.json();
}

/**
 * Log out — deletes the server-side session and clears the cookie.
 */
export async function logout() {
  await apiFetch(`${AUTH_BASE}/logout`, { method: 'POST' });
}

/**
 * Check whether the current session is still valid.
 * Returns the user object if authenticated, or null if not.
 * @returns {{ id: number, email: string, display_name: string } | null}
 */
export async function getMe() {
  // 401 is the normal response when no session exists — not an error worth tracking
  const res = await apiFetch(`${AUTH_BASE}/me`, { skipSentryOn: [401] });
  if (res.status === 401) return null;
  if (!res.ok) return null;
  return res.json();
}

export async function createLead(transcript, language) {
  const res = await apiFetch(`${API_BASE}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, ...(language && { language }) })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create lead');
  }
  return res.json();
}

export async function getLeads() {
  const res = await apiFetch(`${API_BASE}/leads`);
  if (!res.ok) throw new Error('Failed to fetch leads');
  return res.json();
}

export async function updateLeadStatus(id, status) {
  const res = await apiFetch(`${API_BASE}/leads/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update status');
  }
  return res.json();
}

export async function getArchivedLeads() {
  const res = await apiFetch(`${API_BASE}/leads?archived=true`);
  if (!res.ok) throw new Error('Failed to fetch archived leads');
  return res.json();
}

export async function archiveLead(id) {
  const res = await apiFetch(`${API_BASE}/leads/${id}/archive`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: true })
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to archive lead'); }
  return res.json();
}

export async function unarchiveLead(id) {
  const res = await apiFetch(`${API_BASE}/leads/${id}/archive`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: false })
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to unarchive lead'); }
  return res.json();
}

export async function deleteLead(id) {
  const res = await apiFetch(`${API_BASE}/leads/${id}`, { method: 'DELETE' });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to delete lead'); }
  return res.json();
}

export async function getCalls() {
  const res = await apiFetch(`${API_BASE}/calls`);
  if (!res.ok) throw new Error('Failed to fetch calls');
  return res.json();
}

export async function getCallsByPhone(number) {
  const res = await apiFetch(`${API_BASE}/calls/by-phone/${encodeURIComponent(number)}`);
  if (!res.ok) throw new Error('Failed to fetch call notes');
  return res.json();
}

export async function getVoicemailLeads() {
  const res = await apiFetch(`${API_BASE}/leads?source=voicemail`);
  if (!res.ok) throw new Error('Failed to fetch voicemail leads');
  return res.json();
}

export async function initiateCall(to) {
  const res = await apiFetch(`${API_BASE}/twilio/outbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to }),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Call failed'); }
  return res.json(); // { sid, status }
}

export async function translateText(text, targetLang) {
  const res = await apiFetch(`${API_BASE}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLang }),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Translation failed'); }
  return res.json(); // { translated }
}

// Save a contractor-written note for a just-completed outbound call.
// Associates the note with the most recent outbound call to `phone`.
// outcome: 'answered' | 'voicemail' | 'no-answer' | null
export async function saveOutboundNote(phone, note, outcome) {
  const res = await apiFetch(`${API_BASE}/calls/outbound-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, note, outcome }),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to save note'); }
  return res.json();
}

export async function getEmails(mailbox) {
  const url = mailbox ? `${API_BASE}/emails?mailbox=${encodeURIComponent(mailbox)}` : `${API_BASE}/emails`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error('Failed to fetch emails');
  return res.json();
}

export async function getEmailsByPhone(phone) {
  const res = await apiFetch(`${API_BASE}/emails/by-phone/${encodeURIComponent(phone)}`);
  if (!res.ok) throw new Error('Failed to fetch emails by phone');
  return res.json();
}

export async function logEmail(data) {
  const res = await apiFetch(`${API_BASE}/emails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to log email'); }
  return res.json();
}

/** Returns all saved contact profiles as an array. */
export async function getAllContactProfiles() {
  const res = await apiFetch(`${API_BASE}/contacts`);
  if (!res.ok) throw new Error('Failed to fetch contact profiles');
  return res.json();
}

export async function getContactProfile(phone) {
  const res = await apiFetch(`${API_BASE}/contacts/${encodeURIComponent(phone)}`);
  if (!res.ok) throw new Error('Failed to fetch contact profile');
  return res.json(); // null if no saved profile
}

export async function saveContactProfile(phone, data) {
  const res = await apiFetch(`${API_BASE}/contacts/${encodeURIComponent(phone)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to save contact profile'); }
  return res.json();
}

// ── Gmail / email ─────────────────────────────────────────────────────────────

/** Returns { connected: bool, email: string|null } */
export async function getGmailStatus() {
  const res = await apiFetch(`${AUTH_BASE}/gmail-status`);
  if (!res.ok) throw new Error('Failed to get Gmail status');
  return res.json();
}

/** Removes stored Gmail tokens. */
export async function disconnectGmail() {
  const res = await apiFetch(`${AUTH_BASE}/gmail-disconnect`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to disconnect Gmail');
  return res.json();
}

/**
 * Send an outbound email via Gmail and log it.
 * When attachments (File[]) are provided, uses multipart/form-data;
 * otherwise sends JSON (faster, no overhead).
 *
 * @param {{ to: string, subject: string, body: string, attachments?: File[] }} params
 */
export async function sendEmail({ to, subject, body, attachments = [] }) {
  let fetchInit;

  if (attachments.length > 0) {
    const form = new FormData();
    form.append('direction',  'outbound');
    form.append('to_address', to);
    form.append('subject',    subject);
    form.append('body',       body);
    attachments.forEach(file => form.append('attachments', file, file.name));
    fetchInit = { method: 'POST', body: form };
    // Do NOT set Content-Type — browser sets it automatically with boundary
  } else {
    fetchInit = {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ direction: 'outbound', to_address: to, subject, body }),
    };
  }

  const res = await apiFetch(`${API_BASE}/emails`, fetchInit);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send email');
  }
  return res.json();
}

/**
 * Search contacts by name or email address.
 * Returns contacts that have a saved email address.
 * @param {string} q  Search query (min 1 char)
 * @returns {Array<{ phone: string, email: string, name: string }>}
 */
export async function searchContacts(q) {
  if (!q || !q.trim()) return [];
  const res = await apiFetch(`${API_BASE}/contacts/search?q=${encodeURIComponent(q.trim())}`);
  if (!res.ok) return [];
  return res.json();
}

/** Patch email state fields (is_read, is_archived, is_deleted). */
export async function patchEmail(id, data) {
  const res = await apiFetch(`${API_BASE}/emails/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to update email'); }
  return res.json();
}

/** Soft-delete an email (sets is_deleted = 1 on the server). */
export async function softDeleteEmail(id) {
  const res = await apiFetch(`${API_BASE}/emails/${id}`, { method: 'DELETE' });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to delete email'); }
  return res.json();
}

// ── Nav badge counts ──────────────────────────────────────────────────────────

/** Returns { calls, texts, emails } — actionable counts for nav badges. */
export async function getCounts() {
  const res = await apiFetch(`${API_BASE}/counts`);
  if (!res.ok) throw new Error('Failed to fetch counts');
  return res.json();
}

// ── SMS / Messages ────────────────────────────────────────────────────────────

/** Returns conversation list (one entry per phone, latest message + unread count). */
export async function getConversations() {
  const res = await apiFetch(`${API_BASE}/messages`);
  if (!res.ok) throw new Error('Failed to fetch conversations');
  return res.json();
}

/** Returns all messages for a single phone number, oldest first. */
export async function getMessageThread(phone) {
  const res = await apiFetch(`${API_BASE}/messages/${encodeURIComponent(phone)}`);
  if (!res.ok) throw new Error('Failed to fetch message thread');
  return res.json();
}

/**
 * Sends an outbound SMS or MMS via Twilio and persists it.
 * Always uses FormData so the backend multer middleware works consistently
 * for both text-only and media sends.
 *
 * @param {string}   to    Destination phone number
 * @param {string}   body  Message text (may be empty if files provided)
 * @param {File[]}   files Optional image attachments (max 5, ≤5 MB each)
 */
export async function sendMessage(to, body, files = []) {
  const form = new FormData();
  form.append('to', to);
  if (body) form.append('body', body);
  files.forEach(file => form.append('media', file, file.name));

  const res = await apiFetch(`${API_BASE}/messages/send`, {
    method: 'POST',
    // Do NOT set Content-Type — browser sets it automatically with boundary
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send message');
  }
  return res.json();
}

/** Mark all inbound messages for a phone as read. */
export async function markMessagesRead(phone) {
  const res = await apiFetch(`${API_BASE}/messages/${encodeURIComponent(phone)}/read`, { method: 'PATCH' });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Failed to mark read'); }
  return res.json();
}

/** Mark all unseen missed calls (within 48h) as seen. */
export async function markCallsSeen() {
  const res = await apiFetch(`${API_BASE}/calls/mark-seen`, { method: 'POST' });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Failed to mark seen'); }
  return res.json();
}

export async function updateLeadCategory(id, category) {
  const res = await apiFetch(`${API_BASE}/leads/${id}/category`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update category');
  }
  return res.json();
}
