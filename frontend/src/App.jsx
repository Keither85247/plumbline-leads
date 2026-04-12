import { useState, useEffect, useCallback } from 'react';
import TranscriptForm from './components/TranscriptForm';
import AudioUploadForm from './components/AudioUploadForm';
import LeadList from './components/LeadList';
import CallsPage from './components/CallsPage';
import TimelinePage from './components/TimelinePage';
import ContactsPage from './components/ContactsPage';
import SettingsModal from './components/SettingsModal';
import OnboardingModal from './components/OnboardingModal';
import ContactHistoryModal from './components/ContactHistoryModal';
import OutboundNoteModal from './components/OutboundNoteModal';
import InboxLayout from './components/inbox/InboxLayout';
import EmailPage from './components/EmailPage';
import { getLeads, saveOutboundNote, getCounts, API_BASE } from './api';
import { translations } from './i18n';
import { useVoiceDevice } from './hooks/useVoiceDevice';

// Nav icons — labels are injected at render time from translations
const SIDEBAR_NAV_ICONS = [
  {
    id: 'overview',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7m-9 2v8m4-8v8m5 0H4" />
      </svg>
    ),
  },
  {
    id: 'calls',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
      </svg>
    ),
  },
  {
    id: 'text',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z" />
      </svg>
    ),
  },
  {
    id: 'email',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: 'timeline',
    icon: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

// Mobile bottom nav icons
const BOTTOM_NAV_ICONS = [
  {
    id: 'calls',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
      </svg>
    ),
  },
  {
    id: 'leads',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    id: 'text',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z" />
      </svg>
    ),
  },
  {
    id: 'email',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: 'timeline',
    icon: (active) => (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'contacts',
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
  const voiceDevice = useVoiceDevice();

  // Register the voice device on mount so inbound calls ring in the app
  useEffect(() => { voiceDevice.initialize(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [leads, setLeads] = useState([]);
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [activeNav, setActiveNav] = useState('overview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [callsPagePhone, setCallsPagePhone] = useState(null);
  const [language, setLanguage] = useState(
    () => localStorage.getItem('language') || 'en'
  );
  const [replyTranslation, setReplyTranslation] = useState(
    () => localStorage.getItem('replyTranslation') === 'true'
  );
  const [showOnboarding, setShowOnboarding] = useState(
    () => !localStorage.getItem('onboardingComplete')
  );
  const [contractorName, setContractorName] = useState(
    () => localStorage.getItem('contractorName') || ''
  );
  const [businessName, setBusinessName] = useState(
    () => localStorage.getItem('businessName') || ''
  );

  // ── Nav badge counts ──────────────────────────────────────────────────────
  // callsBadge is intentionally separate so it can ONLY be zeroed by the
  // user actually viewing the Recent calls list — never by a nav click or
  // any other indirect code path.
  const [callsBadge, setCallsBadge] = useState(0);
  const [remoteCounts, setRemoteCounts] = useState({ texts: 0, emails: 0 });

  useEffect(() => {
    let cancelled = false;
    const fetch_ = () => getCounts().then(c => {
      if (cancelled) return;
      console.log('[Badge] poll returned calls:', c.calls);
      setCallsBadge(prev => {
        const next = c.calls || 0;
        console.log('[Badge] setCallsBadge prev:', prev, '→ next:', next, '(via poll)');
        return next;
      });
      setRemoteCounts({ texts: c.texts || 0, emails: c.emails || 0 });
    }).catch(() => {});
    fetch_();
    const t = setInterval(fetch_, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // ── Backend health indicator ──────────────────────────────────────────────
  // 'checking' → gray pulse  |  'up' → green  |  'down' → red
  const [backendStatus, setBackendStatus] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    async function ping() {
      try {
        const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
        if (!cancelled) setBackendStatus(res.ok ? 'up' : 'down');
      } catch {
        if (!cancelled) setBackendStatus('down');
      }
    }
    ping();
    const t = setInterval(ping, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const t = translations[language] || translations.en;

  const handleLanguageChange = (lang) => {
    setLanguage(lang);
    localStorage.setItem('language', lang);
  };

  const handleReplyTranslationChange = (val) => {
    setReplyTranslation(val);
    localStorage.setItem('replyTranslation', val ? 'true' : 'false');
  };

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

  const handleBusinessNameChange = (e) => {
    const val = e.target.value;
    setBusinessName(val);
    localStorage.setItem('businessName', val);
  };

  const handleLeadCreated = (newLead) => setLeads(prev => sortLeads([newLead, ...prev]));
  const handleLeadUpdated = (updatedLead) =>
    setLeads(prev => sortLeads(prev.map(l => l.id === updatedLead.id ? updatedLead : l)));
  const handleLeadRemoved = (id) =>
    setLeads(prev => prev.filter(l => l.id !== id));

  const isLeadsView = activeNav === 'overview' || activeNav === 'leads';

  const handleNavChange = (id) => {
    setActiveNav(id);
  };
  // bottom nav: timeline counts as its own view, not leads


  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 md:px-6 sticky top-0 z-30 h-14 flex items-center">
        <div className="flex items-center justify-between w-full gap-4">
          <div className="leading-tight">
            <span className="text-gray-900 font-bold text-lg tracking-tight">PlumbLine</span>
            <span className="text-gray-400 font-semibold text-lg tracking-tight"> Leads</span>
          </div>
          {/* Backend status dot — green when up, gray pulse when deploying/checking/down */}
          <div
            className="flex items-center gap-1.5 mr-1"
            title={backendStatus === 'up' ? 'Backend online' : 'Deploying update…'}
          >
            <span className={`w-2 h-2 rounded-full ${
              backendStatus === 'up' ? 'bg-green-400' : 'bg-gray-300 animate-pulse'
            }`} />
            <span className={`text-[11px] font-medium hidden sm:inline ${
              backendStatus === 'up' ? 'text-green-600' : 'text-gray-400'
            }`}>
              {backendStatus === 'up' ? 'Online' : 'Updating…'}
            </span>
          </div>

          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 text-gray-500 hover:text-gray-700 transition-colors rounded-lg hover:bg-gray-100"
            aria-label="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Body: sidebar (desktop) + content */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar — desktop only */}
        <nav className="hidden md:flex w-44 bg-white border-r border-gray-200 flex-col py-4 shrink-0">
          {SIDEBAR_NAV_ICONS.map(item => (
            <button
              key={item.id}
              onClick={() => handleNavChange(item.id)}
              className={`flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors text-left
                ${activeNav === item.id
                  ? 'text-blue-600 bg-blue-50 border-r-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'
                }`}
            >
              {item.icon}
              {t[item.id]}
            </button>
          ))}
        </nav>

        {/* Main content */}
        {/* Inbox needs overflow-hidden + no padding so it can manage its own scroll internally */}
        <main className={`flex-1 flex flex-col ${
          activeNav === 'text' || activeNav === 'email'
            ? 'overflow-hidden'
            : 'overflow-auto px-4 md:px-6 pt-6 pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-6'
        }`}>
          {isLeadsView && (
            <div className="flex-1 flex flex-col max-w-4xl w-full">
              <div className="hidden">
                <TranscriptForm onLeadCreated={handleLeadCreated} language={language} />
                <AudioUploadForm onLeadCreated={handleLeadCreated} language={language} />
              </div>
              <LeadList
                leads={leads}
                loading={loadingLeads}
                onLeadUpdated={handleLeadUpdated}
                onLeadRemoved={handleLeadRemoved}
                contractorName={contractorName}
                language={language}
                replyTranslation={replyTranslation}
              />
            </div>
          )}

          {activeNav === 'calls' && (
            <CallsPage
              onContactClick={setCallsPagePhone}
              voiceDevice={voiceDevice}
              onCallsSeen={() => { console.log('[Badge] onCallsSeen fired → setCallsBadge(0)'); setCallsBadge(0); }}
            />
          )}

          {activeNav === 'text' && <InboxLayout />}

          {activeNav === 'email' && <EmailPage />}

          {activeNav === 'timeline' && <TimelinePage onContactClick={setCallsPagePhone} />}

          {activeNav === 'contacts' && (
            <ContactsPage leads={leads} voiceDevice={voiceDevice} />
          )}
        </main>
      </div>

      {/* Gradient fade mask — mobile only */}
      <div
        className="md:hidden fixed bottom-0 left-0 right-0"
        style={{
          height: '96px',
          zIndex: 39,
          pointerEvents: 'auto',
          background: 'linear-gradient(to bottom, rgba(249,250,251,0) 0%, rgba(249,250,251,0.6) 50%, rgba(249,250,251,0.92) 100%)',
        }}
      />

      {/* Voice call error toast — shown when a call attempt fails from any page */}
      {voiceDevice.status === 'failed' && voiceDevice.error && (
        <div className="fixed inset-x-0 top-16 z-50 flex justify-center px-4 pointer-events-none">
          <div className="w-full max-w-sm bg-red-50 border border-red-200 rounded-xl shadow-lg px-4 py-3 flex items-center gap-3 pointer-events-auto">
            <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="flex-1 text-sm text-red-700 font-medium">
              Call failed — {voiceDevice.error}
            </p>
          </div>
        </div>
      )}

      {/* Inbound call banner — shown over everything when a call is incoming or active */}
      {(voiceDevice.status === 'incoming' || voiceDevice.status === 'connected') && (
        <div className="fixed inset-x-0 top-16 z-50 flex justify-center px-4">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-gray-200 px-5 py-4 flex items-center gap-4">
            {/* Avatar */}
            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
              </svg>
            </div>
            {/* Info */}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                {voiceDevice.status === 'incoming' ? 'Incoming call' : 'Connected'}
              </p>
              <p className="text-sm font-semibold text-gray-900 truncate">
                {voiceDevice.remoteIdentity || 'Unknown'}
              </p>
            </div>
            {/* Action buttons */}
            {voiceDevice.status === 'incoming' ? (
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={voiceDevice.rejectCall}
                  className="w-10 h-10 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors"
                  aria-label="Decline"
                >
                  <svg className="w-4 h-4 text-white rotate-135" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
                  </svg>
                </button>
                <button
                  onClick={voiceDevice.answerCall}
                  className="w-10 h-10 rounded-full bg-green-500 hover:bg-green-600 flex items-center justify-center transition-colors"
                  aria-label="Answer"
                >
                  <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
                  </svg>
                </button>
              </div>
            ) : (
              <button
                onClick={voiceDevice.hangUp}
                className="w-10 h-10 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors shrink-0"
                aria-label="Hang up"
              >
                <svg className="w-4 h-4 text-white rotate-135" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Post-call note modal — outbound calls only, never inbound */}
      {voiceDevice.pendingPostCallNote && (
        <OutboundNoteModal
          phone={voiceDevice.pendingPostCallNote.phone}
          onSave={(note, outcome) => saveOutboundNote(voiceDevice.pendingPostCallNote.phone, note, outcome)}
          onClose={voiceDevice.clearPostCallNote}
        />
      )}

      {/* Contact history — triggered from Calls page */}
      {callsPagePhone && (
        <ContactHistoryModal
          phone={callsPagePhone}
          leads={leads}
          onClose={() => setCallsPagePhone(null)}
        />
      )}

      {/* Onboarding modal — shown once on first load */}
      {showOnboarding && (
        <OnboardingModal
          language={language}
          onDismiss={() => {
            localStorage.setItem('onboardingComplete', 'true');
            setShowOnboarding(false);
          }}
        />
      )}

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          contractorName={contractorName}
          onContractorNameChange={handleContractorNameChange}
          businessName={businessName}
          onBusinessNameChange={handleBusinessNameChange}
          language={language}
          onLanguageChange={handleLanguageChange}
          replyTranslation={replyTranslation}
          onReplyTranslationChange={handleReplyTranslationChange}
        />
      )}

      {/* Bottom navigation — mobile only, floating pill style */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex justify-center"
           style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)', paddingLeft: '16px', paddingRight: '16px', paddingTop: '8px' }}>
        <nav className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-gray-100 flex items-stretch px-2 py-1">
          {BOTTOM_NAV_ICONS.map(item => {
            const isActive = item.id === 'leads'
              ? activeNav === 'leads' || activeNav === 'overview'
              : activeNav === item.id;

            // Badge count per tab — only first 4 get badges
            const newLeads = leads.filter(l => l.status === 'New').length;
            const badgeCount =
              item.id === 'calls'  ? callsBadge  :
              item.id === 'leads'  ? newLeads            :
              item.id === 'text'   ? remoteCounts.texts  :
              item.id === 'email'  ? remoteCounts.emails :
              0;

            return (
              <button
                key={item.id}
                onClick={() => handleNavChange(item.id)}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl transition-all duration-150
                  ${isActive
                    ? 'text-blue-600 bg-blue-50'
                    : 'text-gray-400 hover:text-gray-600'
                  }`}
              >
                {/* Icon wrapper — relative so badge can be positioned over it */}
                <div className="relative">
                  {item.icon(isActive)}
                  {badgeCount > 0 && (
                    <span className="absolute -top-1 -right-2 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-1 leading-none pointer-events-none">
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </div>
                <span className={`text-[10px] leading-none font-semibold tracking-wide ${isActive ? 'text-blue-600' : 'text-gray-400'}`}>
                  {(t[item.id] || item.id).toUpperCase()}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

    </div>
  );
}
