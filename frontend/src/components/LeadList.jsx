import { useState, useEffect } from 'react';
import LeadCard from './LeadCard';
import ContactHistoryModal from './ContactHistoryModal';
import { getArchivedLeads, unarchiveLead } from '../api';
import { useInvalidate } from '../refreshBus';
import { translations } from '../i18n';

// ─────────────────────────────────────────────────────────────────────────────
// LeadList — matches the approved Figma spec.
//
// Figma layout removes the previous wrapper card. The tabs sit directly on
// the body surface with a single-pixel underline for the active state (no
// pills), followed by a large section header ("Leads · 13 total"), then the
// cards themselves floating on the near-white body with their own halos.
// ─────────────────────────────────────────────────────────────────────────────

function getDateLabel(dateStr, t) {
  const date = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);

  if (date >= todayStart) return t.timeToday;
  if (date >= yesterdayStart) return t.timeYesterday;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function groupLeadsByDate(leads, t) {
  const groups = [];
  const seen = new Map();
  for (const lead of leads) {
    const label = getDateLabel(lead.created_at, t);
    if (!seen.has(label)) {
      seen.set(label, groups.length);
      groups.push({ label, leads: [] });
    }
    groups[seen.get(label)].leads.push(lead);
  }
  return groups;
}

export default function LeadList({ leads, loading, onLeadUpdated, onLeadRemoved, contractorName, language, replyTranslation }) {
  const t = translations[language] || translations.en;

  const TABS = [
    { label: t.leadTabLeads,     category: 'Lead' },
    { label: t.leadTabCustomers, category: 'Existing Customer' },
    { label: t.leadTabVendors,   category: 'Vendor' },
    { label: t.leadTabSpam,      category: 'Spam' },
    { label: t.leadTabOther,     category: 'Other' },
    { label: t.leadTabArchived,  category: '__archived__' },
  ];

  const [activeTab, setActiveTab] = useState('Lead');
  const [selectedPhone, setSelectedPhone] = useState(null);
  const [archivedLeads, setArchivedLeads] = useState([]);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const invalidate = useInvalidate();

  // Fetch archived leads when that tab is activated
  useEffect(() => {
    if (activeTab !== '__archived__') return;
    setLoadingArchived(true);
    getArchivedLeads()
      .then(setArchivedLeads)
      .catch(err => console.error('Failed to load archived leads:', err))
      .finally(() => setLoadingArchived(false));
  }, [activeTab]);

  const isArchivedTab = activeTab === '__archived__';
  const filtered = isArchivedTab
    ? archivedLeads
    : leads.filter(l => (l.category || 'Lead') === activeTab);

  // Unread counts for active (non-archived) tabs
  const unreadCounts = TABS.reduce((acc, tab) => {
    if (tab.category === '__archived__') return acc;
    acc[tab.category] = leads.filter(
      l => (l.category || 'Lead') === tab.category && l.status === 'New'
    ).length;
    return acc;
  }, {});

  const handleUnarchive = async (id) => {
    try {
      await unarchiveLead(id);
      setArchivedLeads(prev => prev.filter(l => l.id !== id));
      invalidate('leads');
    } catch (err) {
      console.error('Unarchive failed:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col">
        <p className="text-sm text-ink-500 animate-pulse mt-8">{t.leadListLoading}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* ── Category tabs ────────────────────────────────────────────────
           Directly on the body, no wrapper card. Active tab uses a black
           underline; inactive tabs use quiet gray text. Horizontal scroll
           on overflow keeps all six accessible on narrow screens. */}
      <div className="flex items-center border-b border-ink-700 overflow-x-auto no-scrollbar">
        {TABS.map(tab => {
          const unread = unreadCounts[tab.category] || 0;
          const isActive = activeTab === tab.category;
          return (
            <button
              key={tab.category}
              onClick={() => setActiveTab(tab.category)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap shrink-0 transition-colors
                ${isActive
                  ? 'font-semibold text-ink-50 border-b-2 border-ink-50 -mb-px'
                  : 'font-normal text-ink-500 border-b-2 border-transparent hover:text-ink-100'
                }`}
            >
              {tab.label}
              {unread > 0 && (
                <span className={`inline-flex items-center justify-center rounded-full text-[11px] font-bold min-w-[18px] h-[18px] px-1 leading-none tabular-nums
                  ${isActive
                    ? 'bg-brand-800 text-white'
                    : 'bg-ink-800 text-ink-500'}`}>
                  {unread}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Section header — big "Leads" title + total count chip ────── */}
      <div className="flex items-center justify-between px-1 pt-6 pb-4">
        <h1 className="text-[26px] font-bold text-ink-50 tracking-tight leading-none">
          {TABS.find(t => t.category === activeTab)?.label}
        </h1>
        <span className="text-[13px] text-ink-500 tabular-nums">
          {filtered.length} {t.leadListTotal}
        </span>
      </div>

      {/* ── Content ─────────────────────────────────────────────────── */}
      {loadingArchived ? (
        <p className="text-sm text-ink-500 animate-pulse text-center py-12">{t.leadListLoadingArchived}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-ink-500 text-center py-12">
          {isArchivedTab ? t.leadListNoArchived : t.leadListNoneYet}
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto no-scrollbar">
          {groupLeadsByDate(filtered, t).map(group => (
            <div key={group.label}>
              <p className="text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] mt-6 mb-3 first:mt-0 px-1">
                {group.label}
              </p>
              <div className="space-y-4">
                {group.leads.map(lead => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    onLeadUpdated={onLeadUpdated}
                    onLeadRemoved={isArchivedTab
                      ? (id) => setArchivedLeads(prev => prev.filter(l => l.id !== id))
                      : onLeadRemoved
                    }
                    contractorName={contractorName}
                    onContactClick={setSelectedPhone}
                    isArchived={isArchivedTab}
                    language={language}
                    replyTranslation={replyTranslation}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedPhone && (
        <ContactHistoryModal
          phone={selectedPhone}
          leads={leads}
          onClose={() => setSelectedPhone(null)}
        />
      )}
    </div>
  );
}
