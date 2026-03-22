import { useState, useEffect, useCallback } from 'react';
import TranscriptForm from './components/TranscriptForm';
import AudioUploadForm from './components/AudioUploadForm';
import LeadList from './components/LeadList';
import CallsPage from './components/CallsPage';
import { getLeads } from './api';

// Desktop sidebar nav
const SIDEBAR_NAV = [
  {
    id: 'overview',
    label: 'Overview',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7m-9 2v8m4-8v8m5 0H4" />
      </svg>
    ),
  },
  {
    id: 'calls',
    label: 'Calls',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
      </svg>
    ),
  },
  {
    id: 'text',
    label: 'Text',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z" />
      </svg>
    ),
  },
];

// Mobile bottom nav — 4 tabs: Calls, Leads, Text, Contacts
const BOTTOM_NAV = [
  {
    id: 'calls',
    label: 'Calls',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
      </svg>
    ),
  },
  {
    id: 'leads',
    label: 'Leads',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    id: 'text',
    label: 'Text',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z" />
      </svg>
    ),
  },
  {
    id: 'contacts',
    label: 'Contacts',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-1a4 4 0 00-5.196-3.764M17 20H7m10 0v-1c0-.653-.126-1.274-.356-1.841M7 20H2v-1a4 4 0 015.196-3.764M7 20v-1c0-.653.126-1.274.356-1.841m0 0A5.97 5.97 0 0112 13c1.796 0 3.408.793 4.502 2.049M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

const STATUS_ORDER = { New: 0, Contacted: 1, Qualified: 2, Closed: 3 };

function sortLeads(leads) {
  return [...leads].sort((a, b) => {
    const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

export default function App() {
  const [leads, setLeads] = useState([]);
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [activeNav, setActiveNav] = useState('overview');
  const [contractorName, setContractorName] = useState(
    () => localStorage.getItem('contractorName') || ''
  );

  const fetchLeads = useCallback(async () => {
    try {
      const data = await getLeads();
      setLeads(data);
    } catch (err) {
      console.error('Failed to load leads:', err);
    } finally {
      setLoadingLeads(false);
    }
  }, []);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const handleContractorNameChange = (e) => {
    const val = e.target.value;
    setContractorName(val);
    localStorage.setItem('contractorName', val);
  };

  const handleLeadCreated = (newLead) => setLeads(prev => sortLeads([newLead, ...prev]));
  const handleLeadUpdated = (updatedLead) =>
    setLeads(prev => sortLeads(prev.map(l => l.id === updatedLead.id ? updatedLead : l)));
  const handleLeadRemoved = (id) =>
    setLeads(prev => prev.filter(l => l.id !== id));

  const isLeadsView = activeNav === 'overview' || activeNav === 'leads';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-700 px-4 md:px-6 sticky top-0 z-30 h-14 flex items-center">
        <div className="flex items-center justify-between w-full gap-4">
          <div className="leading-tight">
            <span className="text-white font-bold text-lg tracking-tight">PlumbLine</span>
            <span className="text-gray-400 font-semibold text-lg tracking-tight"> Leads</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="text-xs text-gray-500 whitespace-nowrap hidden sm:block">Your name</label>
            <input
              type="text"
              value={contractorName}
              onChange={handleContractorNameChange}
              placeholder="Your name"
              className="text-xs bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 w-24 md:w-28
                         text-gray-300 placeholder-gray-600
                         focus:outline-none focus:ring-1 focus:ring-gray-500 focus:border-transparent"
            />
          </div>
        </div>
      </header>

      {/* Body: sidebar (desktop) + content */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar — desktop only */}
        <nav className="hidden md:flex w-44 bg-white border-r border-gray-200 flex-col py-4 shrink-0">
          {SIDEBAR_NAV.map(item => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors text-left
                ${activeNav === item.id
                  ? 'text-blue-600 bg-blue-50 border-r-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'
                }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-auto px-4 md:px-6 py-6" style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom))' }}>
          {isLeadsView && (
            <div className="max-w-4xl">
              <div className="hidden">
                <TranscriptForm onLeadCreated={handleLeadCreated} />
                <AudioUploadForm onLeadCreated={handleLeadCreated} />
              </div>
              <LeadList
                leads={leads}
                loading={loadingLeads}
                onLeadUpdated={handleLeadUpdated}
                onLeadRemoved={handleLeadRemoved}
                contractorName={contractorName}
              />
            </div>
          )}

          {activeNav === 'calls' && <CallsPage />}

          {activeNav === 'text' && (
            <div>
              <h1 className="text-xl font-bold text-gray-900">Text</h1>
              <p className="text-sm text-gray-400 mt-1">Coming soon.</p>
            </div>
          )}

          {activeNav === 'contacts' && (
            <div>
              <h1 className="text-xl font-bold text-gray-900">Contacts</h1>
              <p className="text-sm text-gray-400 mt-1">Coming soon.</p>
            </div>
          )}
        </main>
      </div>

      {/* Bottom navigation — mobile only, floating pill style */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex justify-center"
           style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)', paddingLeft: '16px', paddingRight: '16px', paddingTop: '8px' }}>
        <nav className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-gray-100 flex items-stretch px-2 py-1">
          {BOTTOM_NAV.map(item => {
            const isActive = item.id === 'leads'
              ? activeNav === 'leads' || activeNav === 'overview'
              : activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveNav(item.id)}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl transition-all duration-150
                  ${isActive
                    ? 'text-blue-600 bg-blue-50'
                    : 'text-gray-400 hover:text-gray-600'
                  }`}
              >
                {item.icon(isActive)}
                <span className={`text-[10px] leading-none font-semibold tracking-wide ${isActive ? 'text-blue-600' : 'text-gray-400'}`}>
                  {item.label.toUpperCase()}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

    </div>
  );
}
