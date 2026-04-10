import { useState, useEffect } from 'react';
import { normalizePhone, parseTimestamp } from '../utils/phone';
import { getCallsByPhone, getEmailsByPhone, getMessageThread, getContactProfile, saveContactProfile } from '../api';
import PhoneActionSheet from './PhoneActionSheet';
import AddressAutocomplete from './AddressAutocomplete';

const STATUS_COLORS = {
  New:       'bg-blue-100 text-blue-800',
  Contacted: 'bg-yellow-100 text-yellow-800',
  Qualified: 'bg-green-100 text-green-800',
  Closed:    'bg-gray-100 text-gray-600',
};

const CONTACT_METHODS = ['Call', 'Text', 'Email', 'Any'];

// ── Profile section ──────────────────────────────────────────────────────────

function ProfileSection({ phone, contact, latestLead, onProfileSaved }) {
  const [profile,   setProfile]   = useState(null);
  const [editing,   setEditing]   = useState(false);
  const [draft,     setDraft]     = useState({});
  const [saving,    setSaving]    = useState(false);

  useEffect(() => {
    if (!phone) return;
    getContactProfile(phone)
      .then(p => {
        setProfile(p || {});
        setDraft(p || {});
      })
      .catch(() => { setProfile({}); setDraft({}); });
  }, [phone]);

  function startEdit() {
    setDraft(profile || {});
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const saved = await saveContactProfile(phone, draft);
      setProfile(saved);
      setEditing(false);
      onProfileSaved?.(phone, saved); // notify parent (ContactsPage) to update list
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraft(profile || {});
    setEditing(false);
  }

  // Derive best display name: contact profile overrides AI-extracted lead name
  const name    = profile?.name || (contact.contact_name !== 'Unknown' ? contact.contact_name : null);
  const company = contact.company_name || null;

  // Latest job context from most recent lead
  const latestSummary = latestLead?.summary || null;

  if (profile === null) {
    // Loading skeleton
    return (
      <div className="px-6 py-4 border-b border-gray-100 animate-pulse space-y-2">
        <div className="h-3 bg-gray-100 rounded w-1/3" />
        <div className="h-3 bg-gray-100 rounded w-1/2" />
      </div>
    );
  }

  if (editing) {
    return (
      <div className="px-6 py-4 border-b border-gray-100 space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Edit Profile</p>

        {/* ── Name ── */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Name</label>
          <input
            type="text"
            value={draft.name || ''}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="Full name"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400"
          />
        </div>

        {/* ── Address block ── */}
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Street address</label>
            <AddressAutocomplete
              value={draft.address_line_1 || ''}
              onChange={val => setDraft(d => ({ ...d, address_line_1: val }))}
              onSelect={s => setDraft(d => ({
                ...d,
                address_line_1:    s.address_line_1,
                city:              s.city,
                state:             s.state,
                postal_code:       s.postal_code,
                country:           s.country,
                formatted_address: s.formatted_address,
                lat:               s.lat,
                lng:               s.lng,
              }))}
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <label className="block text-xs text-gray-500 mb-1">City</label>
              <input
                type="text"
                autoComplete="address-level2"
                value={draft.city || ''}
                onChange={e => setDraft(d => ({ ...d, city: e.target.value }))}
                placeholder="City"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400"
              />
            </div>
            <div className="w-20 shrink-0">
              <label className="block text-xs text-gray-500 mb-1">State</label>
              <input
                type="text"
                autoComplete="address-level1"
                value={draft.state || ''}
                onChange={e => setDraft(d => ({ ...d, state: e.target.value }))}
                placeholder="NY"
                maxLength={2}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400 uppercase"
              />
            </div>
            <div className="w-24 shrink-0">
              <label className="block text-xs text-gray-500 mb-1">ZIP</label>
              <input
                type="text"
                autoComplete="postal-code"
                value={draft.postal_code || ''}
                onChange={e => setDraft(d => ({ ...d, postal_code: e.target.value }))}
                placeholder="10001"
                maxLength={10}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Email</label>
          <input
            type="email"
            value={draft.email || ''}
            onChange={e => setDraft(d => ({ ...d, email: e.target.value }))}
            placeholder="email@example.com"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Preferred Contact</label>
          <div className="flex gap-2 flex-wrap">
            {CONTACT_METHODS.map(m => (
              <button
                key={m}
                onClick={() => setDraft(d => ({ ...d, preferred_contact_method: m }))}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  draft.preferred_contact_method === m
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Notes</label>
          <textarea
            value={draft.notes || ''}
            onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
            placeholder="Gate code, dog in yard, preferred contractor…"
            rows={2}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

        <div className="flex gap-2 pt-0.5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-xs font-medium bg-blue-600 text-white rounded-lg px-4 py-1.5 hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleCancel}
            className="text-xs font-medium text-gray-500 hover:text-gray-700 px-3 py-1.5 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // View mode — compose address display from structured fields, falling back to legacy blobs
  const addressDisplay = (() => {
    const street = profile.address_line_1;
    const city   = profile.city;
    const state  = profile.state;
    const zip    = profile.postal_code;
    if (street) {
      const cityLine = [city, state, zip].filter(Boolean).join(', ');
      return cityLine ? `${street}, ${cityLine}` : street;
    }
    return profile.formatted_address || profile.address || null;
  })();

  const hasAnyProfile = addressDisplay || profile.email || profile.notes || profile.preferred_contact_method;

  return (
    <div className="px-6 py-4 border-b border-gray-100">
      {/* Who + company */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-base font-semibold text-gray-900 leading-snug">
            {name || 'Unknown Caller'}
            {company ? <span className="font-normal text-gray-400"> · {company}</span> : null}
          </p>
          {latestSummary && (
            <p className="text-xs text-gray-400 mt-0.5 leading-relaxed line-clamp-2">{latestSummary}</p>
          )}
        </div>
        <button
          onClick={startEdit}
          className="shrink-0 text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1 transition-colors mt-0.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M15.232 5.232l3.536 3.536M9 13l-4 1 1-4 9.293-9.293a1 1 0 011.414 0l2.586 2.586a1 1 0 010 1.414L9 13z" />
          </svg>
          Edit
        </button>
      </div>

      {/* Profile fields */}
      {hasAnyProfile ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          {addressDisplay && (
            <ProfileField icon="location" label="Address" value={addressDisplay} />
          )}
          {profile.email && (
            <ProfileField icon="email" label="Email" value={profile.email} />
          )}
          {profile.preferred_contact_method && (
            <ProfileField icon="contact" label="Preferred" value={profile.preferred_contact_method} />
          )}
          {profile.notes && (
            <div className="col-span-2">
              <ProfileField icon="note" label="Notes" value={profile.notes} />
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={startEdit}
          className="text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1.5 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add address, email, or notes
        </button>
      )}
    </div>
  );
}

function ProfileField({ icon, label, value }) {
  const icons = {
    location: (
      <svg className="w-3 h-3 shrink-0 mt-px text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    email: (
      <svg className="w-3 h-3 shrink-0 mt-px text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    contact: (
      <svg className="w-3 h-3 shrink-0 mt-px text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
      </svg>
    ),
    note: (
      <svg className="w-3 h-3 shrink-0 mt-px text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
  };

  return (
    <div className="flex items-start gap-1.5">
      {icons[icon]}
      <div className="min-w-0">
        <span className="text-gray-400">{label}: </span>
        <span className="text-gray-700 break-words">{value}</span>
      </div>
    </div>
  );
}

// ── Main modal ───────────────────────────────────────────────────────────────

export default function ContactHistoryModal({ phone, leads, onClose, onProfileSaved }) {
  const [callNotes,        setCallNotes]        = useState([]);
  const [emailItems,       setEmailItems]       = useState([]);
  const [textMessages,     setTextMessages]     = useState([]);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);

  useEffect(() => {
    if (!phone) return;
    getCallsByPhone(phone)
      .then(setCallNotes)
      .catch(err => console.error('Failed to load call notes:', err));
    getEmailsByPhone(phone)
      .then(setEmailItems)
      .catch(err => console.error('Failed to load email history:', err));
    getMessageThread(phone)
      .then(setTextMessages)
      .catch(err => console.error('Failed to load text messages:', err));
  }, [phone]);

  if (!phone) return null;

  const normalizedTarget = normalizePhone(phone);

  const history = leads
    .filter(l => {
      const primary  = normalizePhone(l.callback_number || l.phone_number);
      const fallback = normalizePhone(l.phone_number);
      return primary === normalizedTarget || fallback === normalizedTarget;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const contact    = history[0] || {};
  const primaryPhone = contact.callback_number || contact.phone_number || phone;

  // Wrap the full SMS thread as a single timeline entry so it doesn't flood history
  const textThread = textMessages.length > 0 ? [{
    _type:      'text-thread',
    id:         `text-thread-${phone}`,
    created_at: textMessages[textMessages.length - 1].created_at, // most recent = last
    messages:   textMessages,
  }] : [];

  // Merge leads, calls, emails, and texts into a single timeline, newest first
  const timeline = [
    ...history.map(l    => ({ ...l, _type: 'lead'       })),
    ...callNotes.map(c  => ({ ...c, _type: 'call'       })),
    ...emailItems.map(e => ({ ...e, _type: 'email'      })),
    ...textThread,
  ].sort((a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header — phone + close button */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100">
          <button
            onClick={() => setActionSheetPhone(primaryPhone)}
            className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2 transition-colors"
          >
            {primaryPhone}
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">
              {timeline.length} {timeline.length === 1 ? 'interaction' : 'interactions'}
            </span>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 flex flex-col">

          {/* ── Profile section (always at top) ── */}
          <ProfileSection
            phone={normalizedTarget || primaryPhone}
            contact={contact}
            latestLead={history[0] || null}
            onProfileSaved={onProfileSaved}
          />

          {/* ── Interaction history ── */}
          <div className="px-6 py-4 space-y-3 flex-1">
            {timeline.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No history found.</p>
            ) : (
              <>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">History</p>
                {timeline.map(item =>
                  item._type === 'call'        ? <CallNoteItem  key={`call-${item.id}`}        item={item} /> :
                  item._type === 'email'       ? <EmailItem     key={`email-${item.id}`}       item={item} /> :
                  item._type === 'text-thread' ? <TextThreadItem key={`texts-${item.id}`}      item={item} /> :
                                                 <LeadItem      key={`lead-${item.id}`}        item={item} />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {actionSheetPhone && (
        <PhoneActionSheet
          phone={actionSheetPhone}
          onClose={() => setActionSheetPhone(null)}
        />
      )}
    </div>
  );
}

// ── Timeline item sub-components ─────────────────────────────────────────────

function LeadItem({ item: lead }) {
  return (
    <div className="border border-gray-100 rounded-lg p-3.5 bg-gray-50">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">
            {parseTimestamp(lead.created_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })}
          </span>
          <span className="text-xs text-gray-300">·</span>
          <span className="text-xs text-gray-500 bg-gray-200 rounded px-1.5 py-0.5">
            {lead.category || 'Lead'}
          </span>
        </div>
        <span className={`text-xs font-medium rounded-full px-2.5 py-0.5 shrink-0 ${STATUS_COLORS[lead.status] || STATUS_COLORS['New']}`}>
          {lead.status}
        </span>
      </div>
      <p className="text-sm text-gray-700 leading-relaxed">{lead.summary}</p>
      {lead.key_points && lead.key_points.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {(Array.isArray(lead.key_points) ? lead.key_points : JSON.parse(lead.key_points || '[]')).map((point, i) => (
            <li key={i} className="text-xs text-gray-500 flex gap-1.5">
              <span className="text-blue-400 font-bold shrink-0">•</span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

function CallNoteItem({ item: call }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const duration = formatDuration(call.duration);

  return (
    <div className="border border-blue-100 rounded-lg p-3.5 bg-blue-50">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">
            {parseTimestamp(call.created_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })}
          </span>
          <span className="text-xs text-gray-300">·</span>
          <span className="text-xs text-blue-600 bg-blue-100 rounded px-1.5 py-0.5 font-medium">
            {call.classification === 'Outbound' ? 'You called' : 'Answered call'}
          </span>
          {duration && <span className="text-xs text-gray-400">{duration}</span>}
        </div>
      </div>
      {call.summary && (
        <div className="mt-1">
          <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">Summary</p>
          <p className="text-sm text-gray-700 leading-relaxed">{call.summary}</p>
        </div>
      )}
      {call.key_points && call.key_points.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-1">Key Points</p>
          <ul className="space-y-0.5">
            {call.key_points.map((point, i) => (
              <li key={i} className="text-xs text-gray-500 flex gap-1.5">
                <span className="text-blue-400 font-bold shrink-0">•</span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {call.transcript && (
        <div className="mt-2 border-t border-blue-100 pt-2">
          <button
            onClick={() => setShowTranscript(p => !p)}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            {showTranscript ? 'Hide transcript' : 'View transcript'}
          </button>
          {showTranscript && (
            <p className="mt-1.5 text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">
              {call.transcript}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TextThreadItem({ item }) {
  const [expanded, setExpanded] = useState(false);
  const messages = item.messages || [];
  const latest   = messages[messages.length - 1];
  const preview  = latest?.body || '';
  const count    = messages.length;

  // Show up to 20 most recent messages when expanded
  const shown = expanded ? messages.slice(-20) : [];

  return (
    <div
      className="border border-teal-100 rounded-lg bg-teal-50 overflow-hidden cursor-pointer"
      onClick={() => setExpanded(e => !e)}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 p-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs text-gray-400">
              {parseTimestamp(latest?.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              })}
            </span>
            <span className="text-xs text-gray-300">·</span>
            <span className="text-xs font-semibold text-teal-700 bg-teal-100 rounded px-1.5 py-0.5">
              Text Conversation
            </span>
            <span className="text-xs text-gray-400">{count} {count === 1 ? 'message' : 'messages'}</span>
          </div>
          <p className="text-sm text-gray-600 leading-snug truncate">{preview}</p>
        </div>
        <svg
          className={`w-4 h-4 text-teal-300 shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded chat bubbles */}
      {expanded && (
        <div className="px-3.5 pb-3.5 border-t border-teal-100 pt-2.5 space-y-1.5">
          {shown.map((msg, i) => (
            <div key={msg.id ?? i} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[82%] rounded-2xl px-3 py-2 ${
                msg.direction === 'outbound'
                  ? 'bg-teal-500 text-white rounded-br-sm'
                  : 'bg-white text-gray-800 rounded-bl-sm border border-teal-100'
              }`}>
                <p className="text-xs leading-snug">{msg.body}</p>
                <p className={`text-[10px] mt-1 leading-none ${msg.direction === 'outbound' ? 'text-teal-200' : 'text-gray-400'}`}>
                  {parseTimestamp(msg.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {' '}
                  {parseTimestamp(msg.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}
          {count > 20 && !expanded && (
            <p className="text-xs text-gray-400 text-center">Showing last 20 of {count} messages</p>
          )}
        </div>
      )}
    </div>
  );
}

// Return just the email address from strings like "Name <addr@example.com>" or "addr@example.com"
function extractEmailAddress(str) {
  if (!str) return '';
  const match = str.match(/<([^>]+)>/);
  return match ? match[1].trim() : str.trim();
}

// Human-friendly mailbox label
function mailboxLabel(email) {
  const mb = email.mailbox;
  if (mb === 'sent')  return 'Sent';
  if (mb === 'trash') return 'Trash';
  if (mb === 'spam')  return 'Spam';
  // fall back to direction for rows without mailbox metadata
  return email.direction === 'outbound' ? 'Sent' : 'Inbox';
}

function EmailItem({ item: email }) {
  const [expanded, setExpanded] = useState(false);
  const isOutbound  = email.direction === 'outbound';
  const counterpart = isOutbound ? email.to_address : email.from_address;
  const shortAddr   = extractEmailAddress(counterpart);
  const unread      = email.is_read === 0 && !isOutbound;
  const mboxLabel   = mailboxLabel(email);

  return (
    <div
      className={`border rounded-lg bg-violet-50 overflow-hidden ${unread ? 'border-violet-300' : 'border-violet-100'}`}
      onClick={() => setExpanded(e => !e)}
      style={{ cursor: 'pointer' }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 p-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs text-gray-400">
              {parseTimestamp(email.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              })}
            </span>
            <span className="text-xs text-gray-300">·</span>
            <span className="text-xs font-semibold text-violet-600 bg-violet-100 rounded px-1.5 py-0.5">
              {mboxLabel}
            </span>
            {unread && (
              <span className="text-[10px] font-bold text-white bg-violet-500 rounded px-1.5 py-0.5 leading-none">
                UNREAD
              </span>
            )}
          </div>

          {/* Subject (bold if unread) */}
          {email.subject ? (
            <p className={`text-sm leading-snug truncate ${unread ? 'font-bold text-gray-900' : 'font-medium text-gray-800'}`}>
              {email.subject}
            </p>
          ) : (
            <p className="text-sm text-gray-400 italic leading-snug">(no subject)</p>
          )}

          {/* Counterpart address */}
          {shortAddr && (
            <p className="text-xs text-gray-400 mt-0.5 truncate">
              {isOutbound ? 'To: ' : 'From: '}
              <span className="text-gray-600">{shortAddr}</span>
            </p>
          )}
        </div>

        {/* Expand chevron */}
        <svg
          className={`w-4 h-4 text-violet-300 shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expandable preview */}
      {expanded && (
        <div className="px-3.5 pb-3.5 border-t border-violet-100 pt-2.5">
          {email.body_preview ? (
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
              {email.body_preview}
            </p>
          ) : (
            <p className="text-xs text-gray-400 italic">No preview available for this email.</p>
          )}
        </div>
      )}
    </div>
  );
}
