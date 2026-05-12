import { useState, useEffect } from 'react';
import LeadCard from './LeadCard';
import ContactHistoryModal from './ContactHistoryModal';
import { getArchivedLeads, unarchiveLead } from '../api';
import { useInvalidate } from '../refreshBus';
import { translations } from '../i18n';

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
      // Drop the row from the locally-cached archived list immediately so
      // the archived tab reflects the action without waiting for a refetch.
      setArchivedLeads(prev => prev.filter(l => l.id !== id));
      // Invalidate the leads bus key so App.jsx's master fetch picks up the
      // now-unarchived lead. Previously this step was missing — App's `leads`
      // stayed stale until the 30s heartbeat polled, so switching to a
      // category tab showed the lead as "missing" for up to 30 seconds.
      invalidate('leads');
    } catch (err) {
      console.error('Unarchive failed:', err);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">{t.leadListTitle}</h2>
        <p className="text-sm text-gray-400 animate-pulse">{t.leadListLoading}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 flex flex-col bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {/* Tabs */}
        <div className="flex items-center border-b border-gray-200 overflow-x-auto">
          {TABS.map(tab => {
            const unread = unreadCounts[tab.category] || 0;
            const isActive = activeTab === tab.category;
            return (
              <button
                key={tab.category}
                onClick={() => setActiveTab(tab.category)}
                className={`flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap shrink-0 transition-colors
                  ${isActive
                    ? 'font-semibold text-blue-600 border-b-2 border-blue-600'
                    : 'font-normal text-gray-400 border-b-2 border-transparent hover:text-gray-600'
                  }`}
              >
                {tab.label}
                {unread > 0 && (
                  <span className={`inline-flex items-center justify-center rounded-full text-xs font-semibold min-w-[18px] h-[18px] px-1 leading-none
                    ${isActive ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>
                    {unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex-1 flex flex-col p-6 overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-800">
              {TABS.find(t => t.category === activeTab)?.label}
            </h2>
            <span className="text-sm text-gray-500 bg-gray-100 rounded-full px-2.5 py-0.5">
              {filtered.length} {t.leadListTotal}
            </span>
          </div>

          {loadingArchived ? (
            <p className="text-sm text-gray-400 animate-pulse text-center py-12">{t.leadListLoadingArchived}</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">
              {isArchivedTab ? t.leadListNoArchived : t.leadListNoneYet}
            </p>
          ) : (
            <div className="flex-1 overflow-y-auto pr-1">
              {groupLeadsByDate(filtered, t).map(group => (
                <div key={group.label}>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-7 mb-2 first:mt-0">
                    {group.label}
                  </p>
                  <div className="space-y-3">
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
        </div>
      </div>

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
