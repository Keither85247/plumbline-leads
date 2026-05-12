import { useState, useEffect, useMemo, useCallback } from 'react';
import { getCalls, getAllContactProfiles } from '../api';
import { normalizePhone } from '../utils/phone';
import ContactHistoryModal from './ContactHistoryModal';
import PhoneActionSheet    from './PhoneActionSheet';
import AddContactModal     from './AddContactModal';
import { translations }    from '../i18n';

const CATEGORY_STYLES = {
  'Lead':              'bg-blue-50 text-blue-700',
  'Existing Customer': 'bg-green-50 text-green-700',
  'Customer':          'bg-green-50 text-green-700',
  'Vendor':            'bg-purple-50 text-purple-700',
  'Supplier':          'bg-amber-50 text-amber-700',
  'Spam':              'bg-red-50 text-red-600',
};

const AVATAR_COLORS = {
  'Lead':              'bg-blue-100 text-blue-700',
  'Likely Lead':       'bg-blue-100 text-blue-700',
  'Existing Customer': 'bg-green-100 text-green-700',
  'Customer':          'bg-green-100 text-green-700',
  'Vendor':            'bg-purple-100 text-purple-700',
  'Supplier':          'bg-amber-100 text-amber-700',
  'Spam':              'bg-red-100 text-red-600',
  'Likely Spam':       'bg-red-100 text-red-600',
};

function timeAgo(ts, t) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return t.timeJustNow;
  if (m < 60) return `${m}${t.timeAgoM}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${t.timeAgoH}`;
  return `${Math.floor(h / 24)}${t.timeAgoD}`;
}

function extractContext(summary) {
  if (!summary) return null;
  const first = summary.split('.')[0].trim();
  return first.length > 4 ? first : null;
}

// ── Empty state illustration ─────────────────────────────────────────────────
function EmptyState({ onAdd, t }) {
  return (
    <div className="flex flex-col items-center py-16 px-6 text-center">
      {/* Icon */}
      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
      </div>

      <h3 className="text-base font-semibold text-gray-900 mb-1">{t.contactsEmpty}</h3>
      <p className="text-sm text-gray-500 max-w-xs mb-5">{t.contactsEmptySub}</p>

      <button
        onClick={onAdd}
        className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        {t.contactsAdd}
      </button>

      <p className="text-xs text-gray-400 mt-5">{t.contactsEmptyAutoSync}</p>
    </div>
  );
}

// ── Toast ────────────────────────────────────────────────────────────────────
function Toast({ message, onDone }) {
  useEffect(() => {
    const id = setTimeout(onDone, 2800);
    return () => clearTimeout(id);
  }, [onDone]);

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      <div className="bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2 animate-fade-in-up">
        <svg className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        {message}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function ContactsPage({ leads, voiceDevice = {} }) {
  const lang = localStorage.getItem('language') || 'en';
  const t    = translations[lang] || translations.en;

  const { makeCall, status: deviceStatus = 'idle' } = voiceDevice;
  const isBusy = ['dialing', 'ringing', 'connected', 'ended'].includes(deviceStatus);

  const [calls,            setCalls]            = useState([]);
  const [allProfiles,      setAllProfiles]      = useState([]);   // full rows from contacts table
  const [selectedPhone,    setSelectedPhone]    = useState(null);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);
  const [search,           setSearch]           = useState('');
  const [showAddModal,     setShowAddModal]      = useState(false);
  const [toast,            setToast]            = useState(null);

  useEffect(() => {
    getCalls()
      .then(setCalls)
      .catch(err => console.error('[Contacts] calls fetch failed:', err));

    getAllContactProfiles()
      .then(setAllProfiles)
      .catch(() => {});
  }, []);

  // Refresh call data when a call ends so interaction counts stay current
  useEffect(() => {
    if (deviceStatus === 'ended' || deviceStatus === 'ready') {
      getCalls()
        .then(setCalls)
        .catch(() => {});
    }
  }, [deviceStatus]);

  // Update profile name/data in list when ContactHistoryModal saves
  const handleProfileSaved = useCallback((phone, profile) => {
    if (!phone || !profile) return;
    setAllProfiles(prev => {
      const norm = normalizePhone(phone) || phone;
      const idx  = prev.findIndex(p => (normalizePhone(p.phone) || p.phone) === norm);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx]  = { ...next[idx], ...profile };
      return next;
    });
  }, []);

  // Called when AddContactModal saves a new contact
  const handleContactCreated = useCallback((newContact) => {
    setAllProfiles(prev => [newContact, ...prev]);
    setToast(t.contactsSaved);
    // If the new contact has a phone, open its detail view
    if (newContact.phone) setSelectedPhone(newContact.phone);
  }, [t.contactsSaved]);

  // Build profile lookup maps for fast access
  const { profileByPhone, profileById } = useMemo(() => {
    const byPhone = new Map();
    const byId    = new Map();
    for (const p of allProfiles) {
      if (p.phone) byPhone.set(normalizePhone(p.phone) || p.phone, p);
      byId.set(p.id, p);
    }
    return { profileByPhone: byPhone, profileById: byId };
  }, [allProfiles]);

  // Unified contact list: auto-synced (calls+leads) + manually-added profiles
  const contacts = useMemo(() => {
    const map = new Map();

    // ── Leads ────────────────────────────────────────────────────────────────
    for (const lead of leads) {
      const raw = lead.callback_number || lead.phone_number;
      if (!raw) continue;
      const norm = normalizePhone(raw);
      if (!norm) continue;
      const ts  = new Date(lead.created_at).getTime();
      const ex  = map.get(norm);
      if (!ex) {
        map.set(norm, {
          key: norm, normalized: norm, displayPhone: raw,
          name: lead.contact_name !== 'Unknown' ? lead.contact_name : null,
          company: lead.company_name || null,
          category: lead.category || 'Lead',
          lastActivity: ts, context: extractContext(lead.summary), count: 1,
          isManual: false,
        });
      } else {
        ex.count++;
        if (ts > ex.lastActivity) {
          ex.lastActivity = ts;
          if (lead.category) ex.category = lead.category;
          const ctx = extractContext(lead.summary);
          if (ctx) ex.context = ctx;
        }
        if (!ex.name && lead.contact_name && lead.contact_name !== 'Unknown') ex.name = lead.contact_name;
        if (!ex.company && lead.company_name) ex.company = lead.company_name;
      }
    }

    // ── Calls ────────────────────────────────────────────────────────────────
    for (const call of calls) {
      if (!call.from_number) continue;
      const norm = normalizePhone(call.from_number);
      if (!norm) continue;
      const ts = new Date(call.created_at).getTime();
      const ex = map.get(norm);
      if (!ex) {
        map.set(norm, {
          key: norm, normalized: norm, displayPhone: call.from_number,
          name: call.contact_name || null, company: null,
          category: call.classification || null,
          lastActivity: ts, context: null, count: 1, isManual: false,
        });
      } else {
        ex.count++;
        if (ts > ex.lastActivity) ex.lastActivity = ts;
        if (!ex.name && call.contact_name) ex.name = call.contact_name;
      }
    }

    // ── Overlay saved profiles + add manually-created contacts ───────────────
    for (const profile of allProfiles) {
      if (profile.phone) {
        const norm = normalizePhone(profile.phone) || profile.phone;
        const ex   = map.get(norm);
        if (ex) {
          // Merge profile data onto auto-synced entry
          if (profile.name)         ex.name    = profile.name;
          if (profile.company)      ex.company = profile.company;
          if (profile.contact_type) ex.category = profile.contact_type;
        } else {
          // Phone not seen in calls/leads — pure manual contact
          map.set(norm, {
            key: norm, normalized: norm, displayPhone: profile.phone,
            name: profile.name || null, company: profile.company || null,
            category: profile.contact_type || 'Lead',
            lastActivity: new Date(profile.updated_at || Date.now()).getTime(),
            context: profile.notes ? profile.notes.slice(0, 100) : null,
            count: 0, isManual: true, profileId: profile.id,
          });
        }
      } else {
        // Phone-less manual contact — keyed by DB id
        const key = `profile:${profile.id}`;
        if (!map.has(key)) {
          map.set(key, {
            key, normalized: null,
            displayPhone: profile.email || null,
            name: profile.name || profile.email || null,
            company: profile.company || null,
            category: profile.contact_type || 'Lead',
            lastActivity: new Date(profile.updated_at || Date.now()).getTime(),
            context: profile.notes ? profile.notes.slice(0, 100) : null,
            count: 0, isManual: true, profileId: profile.id,
            profileEmail: profile.email,
          });
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => b.lastActivity - a.lastActivity);
  }, [leads, calls, allProfiles]);

  const filtered = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(c =>
      (c.name        || '').toLowerCase().includes(q) ||
      (c.displayPhone || '').includes(q)              ||
      (c.company     || '').toLowerCase().includes(q)
    );
  }, [contacts, search]);

  return (
    <div className="max-w-lg w-full relative">

      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t.contactsTitle}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {contacts.length} {contacts.length === 1 ? t.contactsSingular : t.contactsPlural}
            {contacts.length > 0 && <span> · {t.contactsAutoSynced}</span>}
          </p>
        </div>

        {/* Add Contact button — top-right, always visible */}
        <button
          onClick={() => setShowAddModal(true)}
          className="shrink-0 inline-flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-3.5 py-2 rounded-xl hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          {t.contactsAdd}
        </button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t.contactsSearchPH}
          className="w-full border border-gray-200 rounded-lg px-4 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
        />
      </div>

      {/* Contact list / empty states */}
      {filtered.length === 0 ? (
        search
          ? <p className="text-sm text-gray-400 text-center py-16">{t.contactsNoMatch}</p>
          : <EmptyState onAdd={() => setShowAddModal(true)} t={t} />
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {filtered.map((contact, idx) => {
            const catStyle    = CATEGORY_STYLES[contact.category] || 'bg-gray-100 text-gray-500';
            const avatarColor = AVATAR_COLORS[contact.category]   || 'bg-gray-100 text-gray-500';
            const initial     = contact.name ? contact.name.charAt(0).toUpperCase() : (contact.displayPhone ? '#' : '?');
            const clickPhone  = contact.normalized || contact.displayPhone;

            return (
              <div key={contact.key}>
                {idx > 0 && <div className="h-px bg-gray-50 mx-4" />}

                <div
                  onClick={() => clickPhone && setSelectedPhone(clickPhone)}
                  onKeyDown={e => e.key === 'Enter' && clickPhone && setSelectedPhone(clickPhone)}
                  tabIndex={0}
                  role="button"
                  className="w-full text-left flex items-center px-4 py-3 gap-3 hover:bg-gray-50/80 active:bg-gray-100/60 transition-colors cursor-pointer group outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
                >
                  {/* Avatar */}
                  <div className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${avatarColor}`}>
                    <span className="text-sm font-semibold leading-none">{initial}</span>
                  </div>

                  {/* Name · phone/email · company */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate leading-snug">
                      {contact.name || contact.displayPhone || '—'}
                    </p>
                    {(contact.name || contact.company) && (
                      <p className="text-xs text-gray-400 truncate mt-0.5">
                        {contact.name && contact.displayPhone ? contact.displayPhone : null}
                        {contact.company
                          ? ((contact.name && contact.displayPhone) ? ` · ${contact.company}` : contact.company)
                          : null}
                      </p>
                    )}
                  </div>

                  {/* Right: quick-call + meta + chevron */}
                  <div className="shrink-0 flex items-center gap-2">
                    {contact.normalized && (
                      <button
                        onClick={e => { e.stopPropagation(); setActionSheetPhone(contact.displayPhone); }}
                        className="hidden group-hover:flex p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                        aria-label="Call or text"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round"
                            d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
                        </svg>
                      </button>
                    )}

                    <div className="flex flex-col items-end gap-1">
                      <span className="text-[11px] text-gray-400 whitespace-nowrap tabular-nums">
                        {timeAgo(contact.lastActivity, t)}
                      </span>
                      {contact.category && contact.category !== 'Unknown' && (
                        <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 whitespace-nowrap ${catStyle}`}>
                          {contact.category}
                        </span>
                      )}
                    </div>

                    <svg className="shrink-0 w-4 h-4 text-gray-300 group-hover:text-gray-400 transition-colors"
                      fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Floating "+" FAB for easy access when list is long */}
      {contacts.length > 0 && (
        <button
          onClick={() => setShowAddModal(true)}
          className="fixed bottom-24 right-4 sm:right-6 w-14 h-14 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 active:bg-blue-800 flex items-center justify-center transition-colors z-20 md:hidden"
          aria-label={t.contactsAdd}
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      )}

      {/* Modals */}
      {showAddModal && (
        <AddContactModal
          onClose={() => setShowAddModal(false)}
          onSaved={handleContactCreated}
        />
      )}

      {selectedPhone && (
        <ContactHistoryModal
          phone={selectedPhone}
          leads={leads}
          onClose={() => setSelectedPhone(null)}
          onProfileSaved={handleProfileSaved}
        />
      )}

      {actionSheetPhone && (
        <PhoneActionSheet
          phone={actionSheetPhone}
          onCall={makeCall && !isBusy ? (phone) => makeCall(phone) : undefined}
          onViewHistory={() => { setSelectedPhone(actionSheetPhone); setActionSheetPhone(null); }}
          onClose={() => setActionSheetPhone(null)}
        />
      )}

      {/* Success toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
