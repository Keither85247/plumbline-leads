import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
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
import LoginPage from './components/LoginPage';
import { getLeads, saveOutboundNote, getCounts, getMe, logout, API_BASE, AuthError } from './api';
import { translations } from './i18n';
import { useVoiceDevice } from './hooks/useVoiceDevice';
import { usePushNotifications } from './hooks/usePushNotifications';

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
  // ── Authentication ────────────────────────────────────────────────────────
  // On mount: ask the backend whether the session cookie is still valid.
  // While checking: render nothing (avoids flash of login page on reload).
  // If unauthenticated: show LoginPage.
  // If authenticated: render the full app and update Sentry user context.
  const [currentUser, setCurrentUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    async function checkAuth() {
      let user = null;
      try {
        user = await getMe();
      } catch {
        // First attempt failed — likely Render cold-starting (free tier spins down).
        // Wait 4 s and try once more before deciding the user is unauthenticated.
        // This prevents a cold-start timeout from bouncing a logged-in user to the
        // login page on the very first page load after a period of inactivity.
        await new Promise(r => setTimeout(r, 4000));
        try {
          user = await getMe();
        } catch {
          // Second failure — genuinely unreachable; fall through with user = null
        }
      }
      setCurrentUser(user);
      if (user) Sentry.setUser({ id: String(user.id), email: user.email });
      setAuthChecked(true);
    }
    checkAuth();
  }, []);

  const handleLoginSuccess = (user) => {
    setCurrentUser(user);
    Sentry.setUser({ id: String(user.id), email: user.email });
  };

  const handleLogout = async () => {
    await logout().catch(() => {});
    setCurrentUser(null);
    Sentry.setUser(null);
  };

  const voiceDevice = useVoiceDevice();
  const push = usePushNotifications();

  // Dismiss state for the push permission banner — stored in localStorage so
  // it doesn't reappear after the user taps "Not now".
  const [pushBannerDismissed, setPushBannerDismissed] = useState(
    () => localStorage.getItem('pushBannerDismissed') === '1'
  );
  const dismissPushBanner = () => {
    localStorage.setItem('pushBannerDismissed', '1');
    setPushBannerDismissed(true);
  };
  // Show banner only when: logged in, push supported, not yet granted/denied,
  // and user hasn't dismissed it this session.
  const showPushBanner = !!currentUser
    && push.supported
    && !push.subscribed
    && push.permission === 'default'
    && !pushBannerDismissed;

  // Register the voice device on mount so inbound calls ring in the app
  useEffect(() => {
    if (currentUser) voiceDevice.initialize();
  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!currentUser) return; // don't poll while logged out
    let cancelled = false;
    const fetch_ = async () => {
      try {
        const c = await getCounts();
        if (cancelled) return;
        console.log('[Badge] poll returned calls:', c.calls);
        setCallsBadge(prev => {
          const next = c.calls || 0;
          console.log('[Badge] setCallsBadge prev:', prev, '→ next:', next, '(via poll)');
          return next;
        });
        setRemoteCounts({ texts: c.texts || 0, emails: c.emails || 0 });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof AuthError) {
          // Don't trust a single 401 from a background poll — it could be a
          // cold-start race right after login. Re-verify with /auth/me before
          // clearing the session, so a transient blip doesn't boot the user out.
          try {
            const me = await getMe();
            if (!cancelled && !me) {
              setCurrentUser(null);
              Sentry.setUser(null);
            }
          } catch {
            // Network error on the re-check — leave auth state alone.
          }
        }
        // Network blips, 5xx: ignore silently — badge just doesn't update this tick.
      }
    };
    fetch_();
    const t = setInterval(fetch_, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [currentUser]);

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
      if (err instanceof AuthError) {
        // A single 401 on the initial load shouldn't immediately kick the user out —
        // it could be a cold-start race. The getCounts polling loop is the right
        // place to detect session expiry (fires every 30s, more reliable signal).
        return;
      }
      console.error('Failed to load leads:', err);
    } finally {
      setLoadingLeads(false);
    }
  }, []);

  useEffect(() => { if (currentUser) fetchLeads(); }, [fetchLeads, currentUser]);

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


  // ── Auth gate ─────────────────────────────────────────────────────────────
  // Waiting for the initial /auth/me call → blank screen (no flash)
  if (!authChecked) {
    return (
      <div className="h-dvh flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Not logged in → show login page
  if (!currentUser) {
    return (
      <Sentry.ErrorBoundary fallback={<div className="h-dvh flex items-center justify-center"><p className="text-sm text-gray-500">Something went wrong.</p></div>}>
        <LoginPage onSuccess={handleLoginSuccess} />
      </Sentry.ErrorBoundary>
    );
  }

  return (
    <Sentry.ErrorBoundary fallback={
      <div className="h-dvh flex flex-col items-center justify-center gap-3 p-8 text-center bg-gray-50">
        <p className="text-sm font-semibold text-gray-700">Something went wrong.</p>
        <p className="text-xs text-gray-400">The error has been reported. Try reloading the page.</p>
        <button onClick={() => window.location.reload()} className="text-sm px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          Reload
        </button>
      </div>
    }>
    <div className="h-dvh bg-gray-50 flex flex-col overflow-hidden">

      {/* Push notification permission banner */}
      {showPushBanner && (
        <div className="bg-indigo-600 text-white px-4 py-2.5 flex items-center justify-between gap-3 text-sm z-40">
          <span className="leading-snug">
            <span className="font-semibold">Get call &amp; voicemail alerts</span>
            <span className="opacity-80"> — even when the app is closed</span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={async () => { await push.subscribe(); if (push.permission !== 'denied') dismissPushBanner(); }}
              disabled={push.subscribing}
              className="bg-white text-indigo-700 font-semibold text-xs px-3 py-1.5 rounded-full hover:bg-indigo-50 transition-colors disabled:opacity-60"
            >
              {push.subscribing ? 'Enabling…' : 'Enable'}
            </button>
            <button
              onClick={dismissPushBanner}
              className="opacity-70 hover:opacity-100 transition-opacity p-1"
              aria-label="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

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
          {/* Log out — small button, visible on all screen sizes */}
          <button
            onClick={handleLogout}
            className="p-2 text-gray-400 hover:text-gray-600 transition-colors rounded-lg hover:bg-gray-100"
            aria-label="Log out"
            title={`Log out (${currentUser.email})`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
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
    </Sentry.ErrorBoundary>
  );
}
