import { useState, useMemo } from 'react';
import ConversationItem from './ConversationItem';
import FloatingActionButton from '../ui/FloatingActionButton';
import EmptyState from '../ui/EmptyState';
import { translations } from '../../i18n';
import { normalizePhone, parseTimestamp } from '../../utils/phone';

// ─── Helpers ────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg className="w-4 h-4 text-ink-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
    </svg>
  );
}

function PencilIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}

// Day buckets per the Figma comp: "Today", "Yesterday", then short dates
// ("May 23") for anything older — the same vocabulary the Voicemail list
// uses. The conversation list arrives newest-first, so preserving encounter
// order keeps the groups sorted without an explicit pass.
function bucketLabel(iso, t, lang) {
  if (!iso) return t.timeOlder || 'Earlier';
  const date = parseTimestamp(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart  = new Date(todayStart); yestStart.setDate(todayStart.getDate() - 1);
  if (date >= todayStart) return t.timeToday;
  if (date >= yestStart)  return t.timeYesterday;
  return date.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' });
}

function bucketConversations(conversations, t, lang) {
  const groups = [];
  const seen = new Map();
  for (const conv of conversations) {
    const label = bucketLabel(conv.timestamp, t, lang);
    if (!seen.has(label)) { seen.set(label, groups.length); groups.push({ label, items: [] }); }
    groups[seen.get(label)].items.push(conv);
  }
  return groups;
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function ConversationSkeleton() {
  return (
    <div className="px-4 py-3 flex items-start gap-3 animate-pulse">
      <div className="shrink-0 w-10 h-10 rounded-full bg-ink-800" />
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="flex justify-between">
          <div className="h-3 w-28 bg-ink-800 rounded-full" />
          <div className="h-3 w-8 bg-ink-800 rounded-full" />
        </div>
        <div className="h-2.5 w-40 bg-ink-800 rounded-full" />
      </div>
    </div>
  );
}

function ConversationSkeletonGroup() {
  return (
    <div className="space-y-6 px-4 pt-2">
      {[3, 2].map((count, gi) => (
        <div key={gi}>
          <div className="flex items-center gap-3 mb-2 px-1 animate-pulse">
            <div className="h-2.5 w-14 bg-ink-700 rounded-full" />
            <div className="flex-1 h-px bg-ink-700" />
            <div className="h-2.5 w-4 bg-ink-700 rounded-full" />
          </div>
          <div className="bg-ink-900 rounded-2xl ring-1 ring-ink-700 overflow-hidden">
            {Array.from({ length: count }).map((_, i) => (
              <div key={i}>
                {i > 0 && <div className="h-px bg-ink-800 mx-4" />}
                <ConversationSkeleton />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onCompose,
  onDelete,
  loading = false,
  leads = [],
  voiceDevice,
}) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  const [query, setQuery] = useState('');

  // Build a phone → lead lookup so conversation rows can pull category +
  // follow_up_text without each row re-scanning the whole leads array.
  const leadByPhone = useMemo(() => {
    const map = new Map();
    for (const lead of leads) {
      const raw = lead.callback_number || lead.phone_number;
      if (!raw) continue;
      const norm = normalizePhone(raw) || raw;
      // Keep the most recent lead for a phone (sort isn't strictly needed —
      // the array is roughly newest-first from the API, so first-write-wins
      // gives us the lead we want).
      if (!map.has(norm)) map.set(norm, lead);
    }
    return map;
  }, [leads]);

  const filtered = query.trim()
    ? conversations.filter(c =>
        c.name?.toLowerCase().includes(query.toLowerCase()) ||
        c.phone?.includes(query) ||
        c.company?.toLowerCase().includes(query.toLowerCase())
      )
    : conversations;

  const unreadCount = conversations.reduce((n, c) => n + (c.unread || 0), 0);
  const groups = bucketConversations(filtered, t, lang);

  return (
    <div className="flex flex-col h-full bg-[#F3F4F6]">

      {/* Header — Figma: "Inbox" 26px bold + green outlined unread badge,
           "N total" plain gray on the right. */}
      <div className="shrink-0 px-4 pt-5 pb-3">
        <div className="flex items-center justify-between mb-3.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[26px] font-bold text-[#101828] tracking-tight leading-none">{t.inboxTitle}</h1>
            {unreadCount > 0 && (
              <span className="w-[26px] h-[26px] bg-[#ECFDF3] border border-[#065F46] text-[#065F46] rounded-full text-[13px] font-semibold tabular-nums inline-flex items-center justify-center">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[15px] text-[#667085] tabular-nums">
              {conversations.length} {t.leadListTotal || 'total'}
            </span>
            {/* Desktop compose — mobile uses the FAB below */}
            <button
              onClick={onCompose}
              className="hidden md:inline-flex items-center gap-1.5 bg-[#065F46] text-white text-xs font-semibold rounded-full px-3 py-1.5 active:scale-[0.97] transition-all"
              aria-label={t.inboxComposeAria || 'New conversation'}
            >
              <PencilIcon className="w-3.5 h-3.5" />
              {t.inboxCompose || 'New'}
            </button>
          </div>
        </div>

        {/* Search — Figma: white full-radius pill, magnifier, quiet placeholder */}
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-5 flex items-center">
            <SearchIcon />
          </div>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t.inboxSearchPH}
            className="w-full bg-white rounded-full h-[52px] pl-12 pr-11 text-[16px] text-[#101828] placeholder-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#065F46]/30 transition-shadow"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-4 my-auto text-[#98A2B3] hover:text-[#344054] transition-colors"
              aria-label="Clear search"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" clipRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-10.293a1 1 0 00-1.414-1.414L10 8.586 7.707 6.293a1 1 0 00-1.414 1.414L8.586 10l-2.293 2.293a1 1 0 101.414 1.414L10 11.414l2.293 2.293a1 1 0 001.414-1.414L11.414 10l2.293-2.293z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* List — date-grouped sections inside scroll container */}
      <div className="flex-1 overflow-y-auto pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-4">
        {loading ? (
          <ConversationSkeletonGroup />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z" />
              </svg>
            }
            title={query ? (t.inboxNoResults || 'No matches') : (t.inboxNoConversations || 'No conversations yet')}
            subtitle={query ? undefined : (t.inboxEmptyHint || 'New texts will appear here. Tap Compose to start one.')}
            action={!query ? {
              label: t.inboxCompose || 'New conversation',
              icon: <PencilIcon />,
              onClick: onCompose,
            } : undefined}
          />
        ) : (
          <div className="px-4">
            {groups.map(group => (
              <div key={group.label}>
                {/* Day label — quiet "Today" / "May 23" + hairline, matching
                     the Voicemail groups */}
                <div className="flex items-center gap-3 pt-3 pb-2">
                  <span className="text-[15px] text-[#667085] whitespace-nowrap">{group.label}</span>
                  <div className="flex-1 h-px bg-[#E5E7EB]" />
                </div>
                {/* One white rounded card per day, rows divided by hairlines */}
                <div className="bg-white rounded-3xl overflow-hidden px-2 py-1">
                  {group.items.map((conv, idx) => {
                    const norm = normalizePhone(conv.phone) || conv.phone;
                    const lead = leadByPhone.get(norm);
                    return (
                      <div key={conv.id}>
                        {idx > 0 && <div className="h-px bg-[#F2F4F5] mx-2" />}
                        <ConversationItem
                          conversation={conv}
                          lead={lead}
                          voiceDevice={voiceDevice}
                          selected={conv.id === selectedId}
                          onClick={() => onSelect(conv.id)}
                          onDelete={onDelete}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Floating compose — mobile only, hidden when the search yielded no
           results (we'd rather not encourage a user mid-search to dismiss
           and start fresh). */}
      {!loading && (
        <FloatingActionButton
          onClick={onCompose}
          icon={<PencilIcon />}
          ariaLabel={t.inboxComposeAria || 'New conversation'}
          label={t.inboxCompose || 'New'}
        />
      )}
    </div>
  );
}
