import { useState, useEffect } from 'react';
import LeadCard from './LeadCard';
import ContactHistoryModal from './ContactHistoryModal';
import { getArchivedLeads, unarchiveLead } from '../api';

const TABS = [
  { label: 'Leads',               category: 'Lead' },
  { label: 'Existing Customers',  category: 'Existing Customer' },
  { label: 'Vendors / Suppliers', category: 'Vendor' },
  { label: 'Spam',                category: 'Spam' },
  { label: 'Other',               category: 'Other' },
  { label: 'Archived',            category: '__archived__' },
];

export default function LeadList({ leads, loading, onLeadUpdated, onLeadRemoved, contractorName }) {
  const [activeTab, setActiveTab] = useState('Lead');
  const [selectedPhone, setSelectedPhone] = useState(null);
  const [archivedLeads, setArchivedLeads] = useState([]);
  const [loadingArchived, setLoadingArchived] = useState(false);

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
    } catch (err) {
      console.error('Unarchive failed:', err);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Leads</h2>
        <p className="text-sm text-gray-400 animate-pulse">Loading leads...</p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
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

        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-800">
              {TABS.find(t => t.category === activeTab)?.label}
            </h2>
            <span className="text-sm text-gray-500 bg-gray-100 rounded-full px-2.5 py-0.5">
              {filtered.length} total
            </span>
          </div>

          {loadingArchived ? (
            <p className="text-sm text-gray-400 animate-pulse text-center py-12">Loading archived leads...</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">
              {isArchivedTab ? 'No archived leads.' : `No ${TABS.find(t => t.category === activeTab)?.label.toLowerCase()} yet.`}
            </p>
          ) : (
            <div className="space-y-4 max-h-[60vh] md:max-h-[calc(100vh-280px)] overflow-y-auto pr-1">
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
                />
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
    </>
  );
}
