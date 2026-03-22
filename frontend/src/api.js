const API_BASE = '/api';

export async function createLead(transcript) {
  const res = await fetch(`${API_BASE}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript })
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
