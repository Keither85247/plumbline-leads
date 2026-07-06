import { useState, useEffect } from 'react';
import LeadCard from './LeadCard';
import ContactHistoryModal from './ContactHistoryModal';
import { getArchivedLeads, unarchiveLead } from '../api';
import { useInvalidate } from '../refreshBus';
import { translations } from '../i18n';

// ─────────────────────────────────────────────────────────────────────────────
// LeadList — approved Figma layout.
//
// Structure (top → bottom):
//   1. Tab strip  — full-bleed WHITE surface, active tab = near-black text
//      with a thick black underline; inactive = gray. Hairline border under
//      the whole strip separates it from the gray content area.
//   2. Header row — "Leads" (26px bold) left, "13 total" plain gray right.
//      Sits on the gray canvas.
//   3. Cards     — stacked directly with even gaps. The Figma has NO date
//      group headers on this screen (each card carries its own date).
//
// The component owns its horizontal padding because the tab strip must run
// edge-to-edge while the content below keeps a 16px gutter — App.jsx renders
// the Leads view without main-level padding for this reason.
// ─────────────────────────────────────────────────────────────────────────────

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

  // New-lead counts per category tab (badge shown only when > 0)
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

  return (
    <div className="flex-1 flex flex-col min-h-0">

      {/* ── Tab strip — full-bleed white, black underline for active ───── */}
      <div className="bg-white border-b border-[#EAECF0]">
        <div className="flex items-center overflow-x-auto no-scrollbar px-2">
          {TABS.map(tab => {
            const unread = unreadCounts[tab.category] || 0;
            const isActive = activeTab === tab.category;
            return (
              <button
                key={tab.category}
                onClick={() => setActiveTab(tab.category)}
                className={`relative flex items-center gap-1.5 px-4 py-3.5 text-[16px] whitespace-nowrap shrink-0 transition-colors
                  ${isActive
                    ? 'font-semibold text-[#101828]'
                    : 'font-normal text-[#667085]'
                  }`}
              >
                {tab.label}
                {unread > 0 && (
                  <span className={`inline-flex items-center justify-center rounded-full text-[11px] font-bold min-w-[18px] h-[18px] px-1 leading-none tabular-nums
                    ${isActive ? 'bg-[#065F46] text-white' : 'bg-[#F2F4F7] text-[#475467]'}`}>
                    {unread}
                  </span>
                )}
                {/* Active underline — thick black bar flush with the strip's
                     bottom border, matching the Figma's tab treatment */}
                {isActive && (
                  <span className="absolute left-2 right-2 -bottom-px h-[3px] bg-[#101828] rounded-full" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Header row — big title + plain total, on the gray canvas ───── */}
      <div className="flex items-baseline justify-between px-4 pt-5 pb-2">
        <h1 className="text-[26px] font-bold text-[#101828] tracking-tight leading-none">
          {TABS.find(t => t.category === activeTab)?.label}
        </h1>
        <span className="text-[15px] text-[#667085] tabular-nums">
          {filtered.length} {t.leadListTotal}
        </span>
      </div>

      {/* ── Cards ──────────────────────────────────────────────────────── */}
      {loading ? (
        <p className="text-sm text-[#667085] animate-pulse text-center py-12">{t.leadListLoading}</p>
      ) : loadingArchived ? (
        <p className="text-sm text-[#667085] animate-pulse text-center py-12">{t.leadListLoadingArchived}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-[#667085] text-center py-12">
          {isArchivedTab ? t.leadListNoArchived : t.leadListNoneYet}
        </p>
      ) : (
        // pt-3 keeps the first card's 11px glow halo inside the scroll clip
        // box — without it the top of the halo gets sheared off.
        <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-3 pb-6">
          <div className="space-y-6">
            {filtered.map(lead => (
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
