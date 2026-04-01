import { useState, useEffect, useMemo } from 'react';
import { getCalls } from '../api';
import { normalizePhone } from '../utils/phone';
import ContactHistoryModal from './ContactHistoryModal';
import PhoneActionSheet from './PhoneActionSheet';

const CATEGORY_STYLES = {
  'Lead':              'bg-blue-50 text-blue-700',
  'Existing Customer': 'bg-green-50 text-green-700',
  'Vendor':            'bg-purple-50 text-purple-700',
  'Spam':              'bg-red-50 text-red-600',
};

// Avatar color keyed by category so it doubles as a visual identity signal
const AVATAR_COLORS = {
  'Lead':              'bg-blue-100 text-blue-700',
  'Likely Lead':       'bg-blue-100 text-blue-700',
  'Existing Customer': 'bg-green-100 text-green-700',
  'Vendor':            'bg-purple-100 text-purple-700',
  'Spam':              'bg-red-100 text-red-600',
  'Likely Spam':       'bg-red-100 text-red-600',
};

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? '1d ago' : `${days}d ago`;
}

// Take first sentence of AI summary as a compact context hint
function extractContext(summary) {
  if (!summary) return null;
  const first = summary.split('.')[0].trim();
  return first.length > 4 ? first : null;
}

export default function ContactsPage({ leads }) {
  const [calls,            setCalls]            = useState([]);
  const [selectedPhone,    setSelectedPhone]    = useState(null);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);
  const [search,           setSearch]           = useState('');

  useEffect(() => {
    getCalls()
      .then(setCalls)
      .catch(err => console.error('[Contacts] calls fetch failed:', err));
  }, []);

  // Derive a unified contact list from leads + calls, keyed by normalized phone.
  const contacts = useMemo(() => {
    const map = new Map();

    // ── Leads ────────────────────────────────────────────────────────────────
    for (const lead of leads) {
      const raw = lead.callback_number || lead.phone_number;
      if (!raw) continue;
      const normalized = normalizePhone(raw);
      if (!normalized) continue;

      const ts = new Date(lead.created_at).getTime();
      const existing = map.get(normalized);

      if (!existing) {
        map.set(normalized, {
          normalized,
          displayPhone: raw,
          name:         lead.contact_name !== 'Unknown' ? lead.contact_name : null,
          company:      lead.company_name || null,
          category:     lead.category || 'Lead',
          lastActivity: ts,
          context:      extractContext(lead.summary),
          count:        1,
        });
      } else {
        existing.count++;
        if (ts > existing.lastActivity) {
          existing.lastActivity = ts;
          if (lead.category) existing.category = lead.category;
          // Keep context from the most recent lead
          const ctx = extractContext(lead.summary);
          if (ctx) existing.context = ctx;
        }
        if (!existing.name && lead.contact_name && lead.contact_name !== 'Unknown') {
          existing.name = lead.contact_name;
        }
        if (!existing.company && lead.company_name) {
          existing.company = lead.company_name;
        }
      }
    }

    // ── Calls ────────────────────────────────────────────────────────────────
    for (const call of calls) {
      if (!call.from_number) continue;
      const normalized = normalizePhone(call.from_number);
      if (!normalized) continue;

      const ts = new Date(call.created_at).getTime();
      const existing = map.get(normalized);

      if (!existing) {
        map.set(normalized, {
          normalized,
          displayPhone: call.from_number,
          name:         call.contact_name || null,
          company:      null,
          category:     call.classification || null,
          lastActivity: ts,
          context:      null,
          count:        1,
        });
      } else {
        existing.count++;
        if (ts > existing.lastActivity) existing.lastActivity = ts;
        if (!existing.name && call.contact_name) existing.name = call.contact_name;
      }
    }

    return Array.from(map.values())
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }, [leads, calls]);

  const filtered = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(c =>
      (c.name    || '').toLowerCase().includes(q) ||
      c.displayPhone.includes(q)                  ||
      (c.company || '').toLowerCase().includes(q)
    );
  }, [contacts, search]);

  return (
    <div className="max-w-lg w-full">

      {/* Header */}
      <div className="mb-5">
        <h1 className="text-xl font-bold text-gray-900">Contacts</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'} · auto-synced from calls &amp; leads
        </p>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or number…"
          className="w-full border border-gray-200 rounded-lg px-4 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
        />
      </div>

      {/* Contact list */}
      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-16">
          {search
            ? 'No contacts match your search.'
            : 'No contacts yet — they appear automatically when calls or voicemails come in.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {filtered.map((contact, idx) => {
            const catStyle    = CATEGORY_STYLES[contact.category] || 'bg-gray-100 text-gray-500';
            const avatarColor = AVATAR_COLORS[contact.category]   || 'bg-gray-100 text-gray-500';
            const initial     = contact.name ? contact.name.charAt(0).toUpperCase() : '#';

            return (
              <div key={contact.normalized}>
                {idx > 0 && <div className="h-px bg-gray-50 mx-4" />}

                {/*
                  Outer element is a div (not button) so we can nest the
                  PhoneActionSheet trigger button without invalid HTML.
                  Keyboard and click behaviour is preserved via role + tabIndex.
                */}
                <div
                  onClick={() => setSelectedPhone(contact.displayPhone)}
                  onKeyDown={e => e.key === 'Enter' && setSelectedPhone(contact.displayPhone)}
                  tabIndex={0}
                  role="button"
                  className="w-full text-left flex items-center px-4 py-3 gap-3 hover:bg-gray-50/80 active:bg-gray-100/60 transition-colors cursor-pointer group outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
                >
                  {/* Avatar — color signals category at a glance */}
                  <div className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${avatarColor}`}>
                    <span className="text-sm font-semibold leading-none">{initial}</span>
                  </div>

                  {/* Name · phone · context */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate leading-snug">
                      {contact.name || contact.displayPhone}
                    </p>
                    {(contact.name || contact.company) && (
                      <p className="text-xs text-gray-400 truncate mt-0.5">
                        {contact.name ? contact.displayPhone : null}
                        {contact.company
                          ? (contact.name ? ` · ${contact.company}` : contact.company)
                          : null}
                      </p>
                    )}
                    {contact.context && (
                      <p className="text-[11px] text-gray-400 truncate mt-0.5 leading-snug">
                        {contact.context}
                      </p>
                    )}
                  </div>

                  {/* Right: hover action + meta + chevron */}
                  <div className="shrink-0 flex items-center gap-2">

                    {/* Phone quick-action — appears on hover, opens action sheet */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        setActionSheetPhone(contact.displayPhone);
                      }}
                      className="hidden group-hover:flex p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                      aria-label="Call or text"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round"
                          d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
                      </svg>
                    </button>

                    {/* Timestamp + category badge */}
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-[11px] text-gray-400 whitespace-nowrap tabular-nums">
                        {timeAgo(contact.lastActivity)}
                      </span>
                      {contact.category && contact.category !== 'Unknown' && (
                        <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 whitespace-nowrap ${catStyle}`}>
                          {contact.category}
                        </span>
                      )}
                    </div>

                    {/* Chevron — gets a touch brighter on row hover */}
                    <svg
                      className="shrink-0 w-4 h-4 text-gray-300 group-hover:text-gray-400 transition-colors"
                      fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Contact history modal */}
      {selectedPhone && (
        <ContactHistoryModal
          phone={selectedPhone}
          leads={leads}
          onClose={() => setSelectedPhone(null)}
        />
      )}

      {/* Phone action sheet — triggered from the hover quick-action */}
      {actionSheetPhone && (
        <PhoneActionSheet
          phone={actionSheetPhone}
          onViewHistory={() => {
            setSelectedPhone(actionSheetPhone);
            setActionSheetPhone(null);
          }}
          onClose={() => setActionSheetPhone(null)}
        />
      )}
    </div>
  );
}
