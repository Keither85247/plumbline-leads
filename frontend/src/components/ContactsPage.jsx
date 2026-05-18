import { useState, useEffect, useMemo, useCallback } from 'react';
import { getCalls, getAllContactProfiles, deleteContact } from '../api';
import { normalizePhone, parseTimestamp } from '../utils/phone';
import ContactHistoryModal from './ContactHistoryModal';
import PhoneActionSheet    from './PhoneActionSheet';
import AddContactModal     from './AddContactModal';
import SwipeableRow        from './ui/SwipeableRow';
import GroupedListSection  from './ui/GroupedListSection';
import FloatingActionButton from './ui/FloatingActionButton';
import EmptyState          from './ui/EmptyState';
import Avatar              from './ui/Avatar';
import { translations }    from '../i18n';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// First-letter section key. Anything that doesn't start with A-Z (initials,
// numbers, phone-only contacts) buckets into a single "#" section so it
// doesn't fragment into a digit-per-letter mess.
function sectionKey(contact) {
  const source = (contact.name || '').trim();
  if (!source) return '#';
  const ch = source.charAt(0).toUpperCase();
  return /^[A-Z]$/.test(ch) ? ch : '#';
}

// Pinned-contacts persistence. Lives in localStorage as a phone-set so
// favorites survive across sessions. Phone is the stable key because manual
// contacts (no phone) get the implicit profile-id key when normalized.
const PIN_STORAGE_KEY = 'plumbline.pinned-contacts.v1';

function readPinned() {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writePinned(set) {
  try {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {} // quota / private-mode → silently noop
}

// ─── Icons ──────────────────────────────────────────────────────────────────

const SearchIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
  </svg>
);

const PlusIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
  </svg>
);

const PhoneIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
  </svg>
);

const StarIcon = ({ filled = false, className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5a.6.6 0 011.04 0l2.32 4.7a.6.6 0 00.45.33l5.19.75a.6.6 0 01.33 1.02l-3.76 3.66a.6.6 0 00-.17.53l.89 5.17a.6.6 0 01-.87.63L12 17.85a.6.6 0 00-.56 0l-4.9 2.58a.6.6 0 01-.87-.63l.89-5.17a.6.6 0 00-.17-.53L2.63 10.3a.6.6 0 01.33-1.02l5.19-.75a.6.6 0 00.45-.33z" />
  </svg>
);

// ─── Toast (preserved as-is from the previous version) ──────────────────────

function Toast({ message, onDone }) {
  useEffect(() => {
    const id = setTimeout(onDone, 2800);
    return () => clearTimeout(id);
  }, [onDone]);

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      <div className="bg-ink-50 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2 animate-fade-in-up">
        <svg className="w-4 h-4 text-status-new shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        {message}
      </div>
    </div>
  );
}

// ─── Contact row ────────────────────────────────────────────────────────────

function ContactRow({ contact, t, onTap, onCall, onTogglePin, onDelete, isPinned, voiceDevice }) {
  const phone = contact.normalized || contact.displayPhone;
  const canCall = !!(voiceDevice?.makeCall && voiceDevice?.status !== 'connected' && voiceDevice?.status !== 'dialing');
  const displayName = contact.name || contact.displayPhone || '—';

  // Pin toggle from the star button at row-end. Stop propagation so the row's
  // own tap (which opens the contact history modal) doesn't fire underneath.
  function handlePinTap(e) {
    e.stopPropagation();
    onTogglePin(contact);
  }

  return (
    <SwipeableRow
      // Swipe right → place a call. Available only when the voice device is
      // idle so we don't bump an in-progress call.
      leftAction={canCall && contact.normalized ? {
        icon: <PhoneIcon className="w-5 h-5" />,
        label: t.contactsSwipeCall || 'Call',
        color: 'bg-status-new',
        onTrigger: () => onCall(contact.displayPhone),
      } : undefined}
      // Swipe left → delete (iPhone Contacts convention). Pin moved to a
      // tappable star at row-end so the destructive gesture matches the
      // expected mental model (left = destructive). Only wired when a real
      // contact-profile row exists in the DB (`profileId`) — phone-only
      // rows surfaced from leads/calls have nothing to delete.
      rightAction={onDelete && contact.profileId ? {
        icon: (
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
          </svg>
        ),
        label: t.contactsSwipeDelete || 'Delete',
        color: 'bg-status-urgent',
        onTrigger: () => onDelete(contact),
      } : undefined}
    >
      <div
        onClick={onTap}
        onKeyDown={e => { if (e.key === 'Enter') onTap(); }}
        role="button"
        tabIndex={0}
        className="w-full text-left flex items-center px-4 py-3 gap-3 hover:bg-ink-800/40 active:bg-ink-800/60 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-50"
      >
        <Avatar name={displayName} category={contact.category} size="md" />

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-ink-50 truncate leading-snug">
              {displayName}
            </p>
            <span className="shrink-0 text-[11px] text-ink-400 tabular-nums whitespace-nowrap">
              {timeAgo(contact.lastActivity, t)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {contact.name && contact.displayPhone && (
              <p className="text-xs text-ink-400 truncate tabular-nums">
                {contact.displayPhone}
              </p>
            )}
            {contact.company && (
              <>
                {contact.name && contact.displayPhone && <span className="text-ink-500 text-xs">·</span>}
                <p className="text-xs text-ink-400 truncate">{contact.company}</p>
              </>
            )}
          </div>
        </div>

        {/* Pin toggle — filled star when pinned (amber), outline when not
             (quiet). Tap doesn't bubble to the row, so favorites can be
             toggled without opening the history modal. */}
        <button
          type="button"
          onClick={handlePinTap}
          aria-label={isPinned ? (t.contactsUnpin || 'Unpin') : (t.contactsPin || 'Pin')}
          className={`shrink-0 p-1.5 rounded-lg transition-colors
            ${isPinned
              ? 'text-status-scheduled hover:bg-status-scheduled/10'
              : 'text-ink-400 hover:text-ink-200 hover:bg-black/[0.04]'
            }`}
        >
          <StarIcon filled={isPinned} className="w-4 h-4" />
        </button>
      </div>
    </SwipeableRow>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ContactsPage({ leads, voiceDevice = {}, callsRefreshKey = 0 }) {
  const lang = localStorage.getItem('language') || 'en';
  const t    = translations[lang] || translations.en;

  const { makeCall, status: deviceStatus = 'idle' } = voiceDevice;
  const isBusy = ['dialing', 'ringing', 'connected', 'ended'].includes(deviceStatus);

  const [calls,            setCalls]            = useState([]);
  const [allProfiles,      setAllProfiles]      = useState([]);
  const [selectedPhone,    setSelectedPhone]    = useState(null);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);
  const [search,           setSearch]           = useState('');
  const [showAddModal,     setShowAddModal]     = useState(false);
  const [toast,            setToast]            = useState(null);
  const [pinned,           setPinned]           = useState(() => readPinned());

  // ── Data fetching (unchanged behavior) ─────────────────────────────────
  useEffect(() => {
    getAllContactProfiles().then(setAllProfiles).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCalls()
      .then(data => { if (!cancelled) setCalls(data); })
      .catch(err => console.error('[Contacts] calls fetch failed:', err));
    return () => { cancelled = true; };
  }, [callsRefreshKey]);

  // ── Profile save callback ──────────────────────────────────────────────
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

  const handleContactCreated = useCallback((newContact) => {
    setAllProfiles(prev => [newContact, ...prev]);
    setToast(t.contactsSaved);
    if (newContact.phone) setSelectedPhone(newContact.phone);
  }, [t.contactsSaved]);

  // ── Pin / unpin ─────────────────────────────────────────────────────────
  const handleTogglePin = useCallback((contact) => {
    const key = contact.normalized || contact.key;
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        setToast(t.contactsUnpinned || 'Unpinned');
      } else {
        next.add(key);
        setToast(t.contactsPinnedToast || 'Pinned to top');
      }
      writePinned(next);
      return next;
    });
  }, [t.contactsUnpinned, t.contactsPinnedToast]);

  // ── Delete contact ──────────────────────────────────────────────────────
  // Optimistic: drop the profile row from `allProfiles` immediately so the
  // list refreshes without waiting for the server round-trip. On failure we
  // restore the row and show an error toast. Calls/messages/leads referencing
  // the same phone keep flowing as before — only the profile row is removed.
  const handleDelete = useCallback(async (contact) => {
    if (!contact?.profileId) return; // shouldn't reach — rightAction is gated on this
    const confirmMsg = (t.contactsDeleteConfirm || 'Delete this contact? Calls and texts will stay.')
      + (contact.name ? `\n\n${contact.name}` : '');
    if (!window.confirm(confirmMsg)) return;

    const snapshot = allProfiles;
    setAllProfiles(prev => prev.filter(p => p.id !== contact.profileId));
    setToast(t.contactsDeleted || 'Contact deleted');
    try {
      await deleteContact(contact.profileId);
    } catch (err) {
      console.error('[ContactsPage] Delete failed:', err);
      setAllProfiles(snapshot);
      setToast(t.contactsDeleteFailed || 'Couldn’t delete — try again');
    }
  }, [allProfiles, t.contactsDeleteConfirm, t.contactsDeleted, t.contactsDeleteFailed]);

  // ── Contact merge (unchanged logic — same map of phone → contact) ──────
  const contacts = useMemo(() => {
    const map = new Map();

    for (const lead of leads) {
      const raw = lead.callback_number || lead.phone_number;
      if (!raw) continue;
      const norm = normalizePhone(raw);
      if (!norm) continue;
      const ts  = parseTimestamp(lead.created_at).getTime();
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

    for (const call of calls) {
      if (!call.from_number) continue;
      const norm = normalizePhone(call.from_number);
      if (!norm) continue;
      const ts = parseTimestamp(call.created_at).getTime();
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

    for (const profile of allProfiles) {
      if (profile.phone) {
        const norm = normalizePhone(profile.phone) || profile.phone;
        const ex   = map.get(norm);
        if (ex) {
          if (profile.name)         ex.name    = profile.name;
          if (profile.company)      ex.company = profile.company;
          if (profile.contact_type) ex.category = profile.contact_type;
        } else {
          map.set(norm, {
            key: norm, normalized: norm, displayPhone: profile.phone,
            name: profile.name || null, company: profile.company || null,
            category: profile.contact_type || 'Lead',
            lastActivity: profile.updated_at
              ? parseTimestamp(profile.updated_at).getTime()
              : Date.now(),
            context: profile.notes ? profile.notes.slice(0, 100) : null,
            count: 0, isManual: true, profileId: profile.id,
          });
        }
      } else {
        const key = `profile:${profile.id}`;
        if (!map.has(key)) {
          map.set(key, {
            key, normalized: null,
            displayPhone: profile.email || null,
            name: profile.name || profile.email || null,
            company: profile.company || null,
            category: profile.contact_type || 'Lead',
            lastActivity: profile.updated_at
              ? parseTimestamp(profile.updated_at).getTime()
              : Date.now(),
            context: profile.notes ? profile.notes.slice(0, 100) : null,
            count: 0, isManual: true, profileId: profile.id,
            profileEmail: profile.email,
          });
        }
      }
    }

    return Array.from(map.values());
  }, [leads, calls, allProfiles]);

  // ── Search filter ──────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(c =>
      (c.name        || '').toLowerCase().includes(q) ||
      (c.displayPhone || '').includes(q)              ||
      (c.company     || '').toLowerCase().includes(q)
    );
  }, [contacts, search]);

  // ── Split into Pinned + alphabetical sections ──────────────────────────
  // Pinned contacts come first (sorted by lastActivity desc so the freshest
  // pin sits on top), then a single A-Z run with section letters. "#"
  // collects everything without a leading-letter name.
  const { pinnedItems, alphaSections } = useMemo(() => {
    const pinnedSet = pinned;
    const pinList = [];
    const byLetter = new Map();

    for (const c of filtered) {
      const key = c.normalized || c.key;
      if (pinnedSet.has(key)) {
        pinList.push(c);
        continue;
      }
      const letter = sectionKey(c);
      if (!byLetter.has(letter)) byLetter.set(letter, []);
      byLetter.get(letter).push(c);
    }

    // Pinned by recency
    pinList.sort((a, b) => b.lastActivity - a.lastActivity);

    // Alphabetical sections: name asc, then phone asc
    const sorted = Array.from(byLetter.entries())
      .sort(([a], [b]) => {
        if (a === '#') return 1;
        if (b === '#') return -1;
        return a.localeCompare(b);
      })
      .map(([letter, items]) => ({
        letter,
        items: items.sort((a, b) => {
          const an = (a.name || a.displayPhone || '').toLowerCase();
          const bn = (b.name || b.displayPhone || '').toLowerCase();
          return an.localeCompare(bn);
        }),
      }));

    return { pinnedItems: pinList, alphaSections: sorted };
  }, [filtered, pinned]);

  return (
    <div className="max-w-lg w-full relative">

      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-ink-50 tracking-tight">{t.contactsTitle}</h1>
          <p className="text-sm text-ink-400 mt-0.5">
            {contacts.length} {contacts.length === 1 ? t.contactsSingular : t.contactsPlural}
            {contacts.length > 0 && <span> · {t.contactsAutoSynced}</span>}
          </p>
        </div>

        {/* Desktop Add Contact — mobile uses the FAB at bottom-right */}
        <button
          onClick={() => setShowAddModal(true)}
          className="hidden md:inline-flex shrink-0 items-center gap-1.5 bg-ink-50 hover:bg-ink-100 text-white text-sm font-semibold px-4 py-2 rounded-full transition-colors active:scale-[0.97]"
        >
          <PlusIcon className="w-4 h-4" />
          {t.contactsAdd}
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <div className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center">
          <SearchIcon className="w-4 h-4 text-ink-400" />
        </div>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t.contactsSearchPH}
          className="w-full bg-ink-900 ring-1 ring-ink-700 rounded-xl pl-10 pr-9 py-2.5 text-sm text-ink-100 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-50 transition-all"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute inset-y-0 right-3 my-auto text-ink-400 hover:text-ink-100 transition-colors"
            aria-label="Clear search"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-10.293a1 1 0 00-1.414-1.414L10 8.586 7.707 6.293a1 1 0 00-1.414 1.414L8.586 10l-2.293 2.293a1 1 0 101.414 1.414L10 11.414l2.293 2.293a1 1 0 001.414-1.414L11.414 10l2.293-2.293z" />
            </svg>
          </button>
        )}
      </div>

      {/* Lists */}
      {filtered.length === 0 ? (
        search
          ? <EmptyState
              icon={<SearchIcon className="w-5 h-5" />}
              title={t.contactsNoMatch || 'No matches'}
              subtitle={t.contactsNoMatchHint || 'Try a different name, phone, or company.'}
            />
          : <EmptyState
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
              }
              title={t.contactsEmpty}
              subtitle={t.contactsEmptySub}
              action={{
                label: t.contactsAdd,
                icon: <PlusIcon />,
                onClick: () => setShowAddModal(true),
              }}
            />
      ) : (
        <div className="space-y-6 pb-24">
          {/* Pinned section — only shown when there are pinned contacts */}
          {pinnedItems.length > 0 && (
            <GroupedListSection
              label={t.contactsPinnedSection || 'Pinned'}
              count={pinnedItems.length}
            >
              {pinnedItems.map(contact => (
                <ContactRow
                  key={contact.key}
                  contact={contact}
                  t={t}
                  voiceDevice={voiceDevice}
                  isPinned={true}
                  onTap={() => contact.normalized
                    ? setSelectedPhone(contact.normalized)
                    : setSelectedPhone(contact.displayPhone)}
                  onCall={(phone) => setActionSheetPhone(phone)}
                  onTogglePin={handleTogglePin}
                  onDelete={handleDelete}
                />
              ))}
            </GroupedListSection>
          )}

          {/* A-Z sections */}
          {alphaSections.map(section => (
            <GroupedListSection
              key={section.letter}
              label={section.letter}
              count={section.items.length}
              tone="quiet"
            >
              {section.items.map(contact => (
                <ContactRow
                  key={contact.key}
                  contact={contact}
                  t={t}
                  voiceDevice={voiceDevice}
                  isPinned={pinned.has(contact.normalized || contact.key)}
                  onTap={() => contact.normalized
                    ? setSelectedPhone(contact.normalized)
                    : setSelectedPhone(contact.displayPhone)}
                  onCall={(phone) => setActionSheetPhone(phone)}
                  onTogglePin={handleTogglePin}
                  onDelete={handleDelete}
                />
              ))}
            </GroupedListSection>
          ))}
        </div>
      )}

      {/* Floating Add — mobile only, replaces the redundant header button */}
      {contacts.length > 0 && (
        <FloatingActionButton
          onClick={() => setShowAddModal(true)}
          icon={<PlusIcon className="w-5 h-5" />}
          ariaLabel={t.contactsAdd}
        />
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

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
