const API_BASE = '/api';

export async function createLead(transcript, language) {
  const res = await fetch(`${API_BASE}/leads`, {
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
  const res = await fetch(`${API_BASE}/leads`);
  if (!res.ok) throw new Error('Failed to fetch leads');
  return res.json();
}

export async function updateLeadStatus(id, status) {
  const res = await fetch(`${API_BASE}/leads/${id}/status`, {
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
  const res = await fetch(`${API_BASE}/leads?archived=true`);
  if (!res.ok) throw new Error('Failed to fetch archived leads');
  return res.json();
}

export async function archiveLead(id) {
  const res = await fetch(`${API_BASE}/leads/${id}/archive`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: true })
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to archive lead'); }
  return res.json();
}

export async function unarchiveLead(id) {
  const res = await fetch(`${API_BASE}/leads/${id}/archive`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: false })
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to unarchive lead'); }
  return res.json();
}

export async function deleteLead(id) {
  const res = await fetch(`${API_BASE}/leads/${id}`, { method: 'DELETE' });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to delete lead'); }
  return res.json();
}

export async function getCalls() {
  const res = await fetch(`${API_BASE}/calls`);
  if (!res.ok) throw new Error('Failed to fetch calls');
  return res.json();
}

export async function getCallsByPhone(number) {
  const res = await fetch(`${API_BASE}/calls/by-phone/${encodeURIComponent(number)}`);
  if (!res.ok) throw new Error('Failed to fetch call notes');
  return res.json();
}

export async function getVoicemailLeads() {
  const res = await fetch(`${API_BASE}/leads?source=voicemail`);
  if (!res.ok) throw new Error('Failed to fetch voicemail leads');
  return res.json();
}

export async function initiateCall(to) {
  const res = await fetch(`${API_BASE}/twilio/outbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to }),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Call failed'); }
  return res.json(); // { sid, status }
}

export async function translateText(text, targetLang) {
  const res = await fetch(`${API_BASE}/translate`, {
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
  const res = await fetch(`${API_BASE}/calls/outbound-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, note, outcome }),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to save note'); }
  return res.json();
}

export async function getContactProfile(phone) {
  const res = await fetch(`${API_BASE}/contacts/${encodeURIComponent(phone)}`);
  if (!res.ok) throw new Error('Failed to fetch contact profile');
  return res.json(); // null if no saved profile
}

export async function saveContactProfile(phone, data) {
  const res = await fetch(`${API_BASE}/contacts/${encodeURIComponent(phone)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to save contact profile'); }
  return res.json();
}

export async function updateLeadCategory(id, category) {
  const res = await fetch(`${API_BASE}/leads/${id}/category`, {
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
