import { useState, useEffect, useCallback, useRef } from 'react';
import { useRefreshKey, useInvalidate } from './refreshBus';
import * as Sentry from '@sentry/react';
import TranscriptForm from './components/TranscriptForm';
import AudioUploadForm from './components/AudioUploadForm';
import LeadList from './components/LeadList';
import CallsPage from './components/CallsPage';
import TimelinePage from './components/TimelinePage';
import ContactsPage from './components/ContactsPage';
import SettingsModal from './components/SettingsModal';
import FirstRunOnboarding from './components/onboarding/FirstRunOnboarding';
import ContactHistoryModal from './components/ContactHistoryModal';
import OutboundNoteModal from './components/OutboundNoteModal';
import InboxLayout from './components/inbox/InboxLayout';
import EmailPage from './components/EmailPage';
import AdminPage from './components/AdminPage';
import PaywallGate from './components/PaywallGate';
import LoginPage from './components/LoginPage';
import NumberPickerModal from './components/NumberPickerModal';
import { getLeads, saveOutboundNote, getCounts, getMe, logout, updateProfile, API_BASE, AuthError } from './api';
import { parseTimestamp } from './utils/phone';
import { translations } from './i18n';
import { useVoiceDevice } from './hooks/useVoiceDevice';
import { usePushNotifications } from './hooks/usePushNotifications';
import { useCapacitorPush } from './hooks/useCapacitorPush';

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

// ── Paywall access helper ─────────────────────────────────────────────────────
// Returns true when the user should be allowed past the paywall gate.
// This is the ONLY place that decides paywall access — keep it here.
//
// To add Stripe/subscription later:
//  - Add 'active' and 'trial' to the allowed statuses below (already there)
//  - Set access_status on the backend when subscription is confirmed
//
// To remove tester bypass:
//  - Set VITE_ENABLE_TESTER_BYPASS=false on Vercel
//  - Set ENABLE_TESTER_BYPASS=false on Render
//  - The 'tester' status still grants access so existing testers aren't locked out;
//    stop accepting new tester bypasses via the env vars instead.
function paywallCleared(user) {
  if (!user) return false;
  if (user.is_owner) return true;
  const status = user.access_status || '';
  if (['tester', 'active', 'trial'].includes(status)) return true;
  // Legacy localStorage flag — lets existing testers (who bypassed pre-server-tracking)
  // pass through without seeing the paywall again. Removed once all users have
  // server-side status upgraded.
  if (localStorage.getItem('plIsTester') === '1') return true;
  return false;
}

const STATUS_ORDER = { New: 0, Contacted: 1, Qualified: 2, Closed: 3 };

function sortLeads(leads) {
  return [...leads].sort((a, b) => {
    const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (statusDiff !== 0) return statusDiff;
    return parseTimestamp(b.created_at) - parseTimestamp(a.created_at);
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
  // null = not checked yet; false = needs to pick a number; object = has a number
  const [assignedNumber, setAssignedNumber] = useState(null);

  const checkAssignedNumber = (user) => {
    // Owners always have access — they manage numbers, not claim them.
    // For non-owners, the login and /auth/me responses now include assignedNumber
    // directly — no separate network call needed, no cold-start race condition.
    if (user?.is_owner) {
      setAssignedNumber(true);
      return;
    }
    // user.assignedNumber is the phone_numbers row (truthy) or null (needs picker)
    setAssignedNumber(user?.assignedNumber || false);
  };

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
      if (user) {
        Sentry.setUser({ id: String(user.id), email: user.email });
        await checkAssignedNumber(user);
      }
      setAuthChecked(true);
    }
    checkAuth();
  }, []);

  const handleLoginSuccess = async (user) => {
    setCurrentUser(user);
    Sentry.setUser({ id: String(user.id), email: user.email });
    await checkAssignedNumber(user);
  };

  const handleLogout = async () => {
    await logout().catch(() => {});
    setCurrentUser(null);
    Sentry.setUser(null);
  };

  const voiceDevice = useVoiceDevice();
  const push = usePushNotifications();
  // Native FCM push for Android (Capacitor). No-op on web.
  useCapacitorPush();

  // Dismiss state for the push permission banner — stored in localStorage so
  // it doesn't reappear after the user taps "Not now".
  const [pushBannerDismissed, setPushBannerDismissed] = useState(
    () => localStorage.getItem('pushBannerDismissed') === '1'
  );
  const dismissPushBanner = () => {
    localStorage.setItem('pushBannerDismissed', '1');
    setPushBannerDismissed(true);
  };
  // Show banner when: logged in, push supported, not yet subscribed,
  // permission is 'default' (never asked) or 'granted' (OS granted but sub failed),
  // and user hasn't dismissed it.
  const showPushBanner = !!currentUser
    && push.supported
    && !push.subscribed
    && (push.permission === 'default' || push.permission === 'granted')
    && !pushBannerDismissed;

  // Register the voice device on mount so inbound calls ring in the app
  useEffect(() => {
    if (currentUser) voiceDevice.initialize();
  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Calls-data refresh signal ─────────────────────────────────────────────
  // Sourced from the refresh bus (see refreshBus.jsx). The bus's
  // `versions.calls` integer changes whenever someone calls
  // invalidate('calls'). Existing child components (CallsPage, ContactsPage,
  // TimelinePage, ContactHistoryModal) continue to receive `callsRefreshKey`
  // as a prop, so this swap is invisible to them.
  //
  // Bump triggers:
  //   1. voiceDevice.status hits 'ended' or 'ready' — the call row was just
  //      logged by the /voice-client webhook; refresh so it shows up.
  //   2. ~6 seconds after a call ends — catches the asynchronous Twilio
  //      recording-status webhook that lands later with duration/recording_url.
  //   3. After saveOutboundNote() resolves — see the OutboundNoteModal wiring
  //      below.
  //
  // Background refreshes never blank existing data — children own their own
  // fetch state.
  const callsRefreshKey = useRefreshKey('calls');
  const invalidate      = useInvalidate();

  // The 6-second delayed refresh lives in a ref instead of an effect cleanup
  // so the 'ended' → 'ready' transition (1.5s later) does NOT cancel it.
  // Without the ref, React would clear the timer on the next render, and the
  // late-arriving recording webhook would never reach the UI.
  const delayedCallsRefreshRef = useRef(null);

  useEffect(() => {
    if (voiceDevice.status === 'ended' || voiceDevice.status === 'ready') {
      invalidate('calls');
    }
    if (voiceDevice.status === 'ended') {
      // Replace any in-flight timer from a previous call so back-to-back
      // calls don't stack refreshes — each call gets exactly one delayed bump.
      clearTimeout(delayedCallsRefreshRef.current);
      delayedCallsRefreshRef.current = setTimeout(() => invalidate('calls'), 6000);
    }
  }, [voiceDevice.status, invalidate]);

  // Drop the pending delayed refresh on unmount (e.g. logout).
  useEffect(() => () => clearTimeout(delayedCallsRefreshRef.current), []);

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
  const [onboardingSeen, setOnboardingSeen] = useState(
    () => localStorage.getItem('plOnboardingSeen') === '1'
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

  // Watch the bus's `counts` key — invalidate('counts') from anywhere
  // (EmailPage's mark-as-read, future inbox / leads mutations, etc.)
  // re-fires this effect immediately instead of waiting for the 30s tick.
  const countsRefreshKey = useRefreshKey('counts');

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
  }, [currentUser, countsRefreshKey]);

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

  // ── Leads fetch — driven by the refresh bus ──────────────────────────────
  // Single fetch effect — fires on sign-in and every time `leads` is
  // invalidated. fetchLeads sets loadingLeads=false in its finally but never
  // back to true, so background refreshes don't flicker the skeleton; the
  // LeadList keys rows by lead.id, so React reconciles in place.
  const leadsRefreshKey = useRefreshKey('leads');
  useEffect(() => {
    if (currentUser) fetchLeads();
  }, [fetchLeads, currentUser, leadsRefreshKey]);

  // Heartbeat — invalidate the leads key every 30s while signed in. Each
  // invalidation bumps leadsRefreshKey and re-runs the fetch effect above.
  // visibility/focus refresh is handled globally by the RefreshBusProvider
  // (calls invalidate('all')), so no per-feature listener is needed here.
  useEffect(() => {
    if (!currentUser) return;
    const interval = setInterval(() => invalidate('leads'), 30_000);
    return () => clearInterval(interval);
  }, [currentUser, invalidate]);

  // Tab activation — opening the Leads (Overview) tab triggers an immediate
  // invalidation so the user always lands on fresh data.
  useEffect(() => {
    if (currentUser && activeNav === 'overview') invalidate('leads');
  }, [activeNav, currentUser, invalidate]);

  // Post-call / voicemail — a voicemail processed by /api/twilio/voicemail
  // creates a lead asynchronously. callsRefreshKey already bumps after any
  // call event (including the 6s delayed bump for the recording webhook), so
  // we ride that signal to refresh leads too.
  useEffect(() => {
    if (currentUser && callsRefreshKey > 0) invalidate('leads');
  }, [callsRefreshKey, currentUser, invalidate]);

  const handleProfileSave = useCallback(async ({ displayName, businessName: bizName }) => {
    const saved = await updateProfile({ displayName, businessName: bizName });
    // Persist to localStorage as local cache
    setContractorName(saved.display_name ?? displayName);
    setBusinessName(saved.business_name ?? bizName);
    localStorage.setItem('contractorName', saved.display_name ?? displayName);
    localStorage.setItem('businessName',   saved.business_name ?? bizName);
    // Refresh display name in header
    setCurrentUser(prev => prev ? { ...prev, display_name: saved.display_name } : prev);
  }, []);

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
  // First-run onboarding — shown before everything else, even auth
  if (!onboardingSeen) {
    return (
      <FirstRunOnboarding onComplete={() => setOnboardingSeen(true)} />
    );
  }

  // Waiting for the initial /auth/me call → blank screen (no flash)
  // Show spinner while: (a) initial auth check in progress, or
  // (b) logged in but still checking whether this user has a number assigned.
  if (!authChecked || (currentUser && assignedNumber === null)) {
    return (
      <div className="h-dvh flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-ink-50 border-t-transparent rounded-full animate-spin" />
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

  // Paywall gate — shown when user hasn't cleared access yet
  // Owner accounts and users with access_status tester/active/trial pass through.
  if (!paywallCleared(currentUser)) {
    return (
      <PaywallGate
        user={currentUser}
        onBypass={(updatedUser) => {
          setCurrentUser(updatedUser);
          // If the user still has no number, checkAssignedNumber will handle it
          checkAssignedNumber(updatedUser);
        }}
      />
    );
  }

  // Non-owner has no assigned number → show blocking number picker
  if (assignedNumber === false) {
    return (
      <NumberPickerModal
        onClaimed={(row) => setAssignedNumber(row)}
      />
    );
  }

  return (
    <Sentry.ErrorBoundary fallback={
      <div className="h-dvh flex flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-semibold text-ink-100">{t.appSomethingWrong}</p>
        <p className="text-xs text-ink-400">{t.appErrorReported}</p>
        <button onClick={() => window.location.reload()} className="text-sm px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors">
          {t.appReload}
        </button>
      </div>
    }>
    <div className="h-dvh flex flex-col overflow-hidden">

      {/* Push notification permission banner */}
      {showPushBanner && (
        <div className="bg-indigo-600 text-white px-4 py-2.5 flex items-center justify-between gap-3 text-sm z-40">
          <span className="leading-snug">
            <span className="font-semibold">{t.appGetAlerts}</span>
            <span className="opacity-80"> {t.appEvenWhenClosed}</span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={async () => { const ok = await push.subscribe(); if (ok) dismissPushBanner(); }}
              disabled={push.subscribing}
              className="bg-white text-indigo-700 font-semibold text-xs px-3 py-1.5 rounded-full hover:bg-indigo-50 transition-colors disabled:opacity-60"
            >
              {push.subscribing ? t.appEnablingPush : t.appEnablePush}
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

      {/* Header — matches the Figma top bar. Solid white surface, brand
           wordmark on the left ("PlumbLine" bold black + "Leads" medium
           gray), settings + logout icons on the right sitting inside soft
           gray circular buttons. The status-dot (backend online/pulse) is
           preserved as a subtle indicator between the wordmark and the
           action buttons. */}
      <header
        className="bg-white px-4 md:px-6 sticky top-0 z-30"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="h-[60px] flex items-center justify-between w-full gap-4">
          {/* Wordmark — "PlumbLine" near-black bold, "Leads" muted gray-green */}
          <div className="leading-tight">
            <span className="text-[#101828] font-bold text-[21px] tracking-tight">PlumbLine</span>
            <span className="text-[#98A29B] font-semibold text-[21px] tracking-tight"> Leads</span>
          </div>

          {/* Right cluster: status-dot + circular icon buttons */}
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center gap-1.5 mr-0.5"
              title={backendStatus === 'up' ? 'Backend online' : 'Deploying update…'}
            >
              <span className={`w-2 h-2 rounded-full ${
                backendStatus === 'up'
                  ? 'bg-[#12B76A]'
                  : 'bg-[#98A2B3] animate-pulse'
              }`} />
              <span className={`text-[11px] font-medium hidden sm:inline ${
                backendStatus === 'up' ? 'text-[#067647]' : 'text-[#667085]'
              }`}>
                {backendStatus === 'up' ? t.appOnline : t.appUpdating}
              </span>
            </div>

            {/* Settings — light gray circle, per Figma top bar */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-11 h-11 rounded-full bg-[#F3F4F6] text-[#344054] active:bg-[#E5E7EB]
                         flex items-center justify-center transition-colors"
              aria-label="Settings"
            >
              <svg style={{ width: 19, height: 19 }} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            {/* Log out — light gray circle */}
            <button
              onClick={handleLogout}
              className="w-11 h-11 rounded-full bg-[#F3F4F6] text-[#344054] active:bg-[#E5E7EB]
                         flex items-center justify-center transition-colors"
              aria-label="Log out"
              title={`Log out (${currentUser.email})`}
            >
              <svg style={{ width: 17, height: 17 }} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Body: sidebar (desktop) + content */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar — desktop only. White surface with a soft right border.
             Active row: near-black text on a faint ink-800 tint (the "black
             pill" motif adapted for a full-width row). */}
        <nav className="hidden md:flex w-44 bg-ink-900 border-r border-ink-700 flex-col py-4 shrink-0">
          {SIDEBAR_NAV_ICONS.map(item => (
            <button
              key={item.id}
              onClick={() => handleNavChange(item.id)}
              className={`flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors text-left
                ${activeNav === item.id
                  ? 'text-ink-50 bg-ink-800 border-r-2 border-ink-50'
                  : 'text-ink-400 hover:text-ink-100 hover:bg-black/[0.03]'
                }`}
            >
              {item.icon}
              {t[item.id]}
            </button>
          ))}
          {/* Admin lives in Settings → Admin row (owner-only), not in the
               sidebar — keeps the sidebar surface uniform across owner and
               non-owner users. */}
        </nav>

        {/* Main content */}
        {/* Inbox needs overflow-hidden + no padding so it can manage its own
             scroll internally. Leads needs NO horizontal padding because its
             tab strip runs edge-to-edge (white surface on the gray canvas);
             LeadList owns its own gutters. */}
        <main className={`flex-1 flex flex-col ${
          activeNav === 'text' || activeNav === 'email'
            ? 'overflow-hidden'
            : (isLeadsView || activeNav === 'calls')
              ? 'overflow-auto pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-6'
              : 'overflow-auto px-4 md:px-6 pt-6 pb-[calc(80px+env(safe-area-inset-bottom))] md:pb-6'
        }`}>
          {isLeadsView && (
            <div className="flex-1 flex flex-col w-full md:max-w-4xl md:mx-auto">
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
              callsRefreshKey={callsRefreshKey}
              onCallsSeen={() => { console.log('[Badge] onCallsSeen fired → setCallsBadge(0)'); setCallsBadge(0); }}
            />
          )}

          {activeNav === 'text' && <InboxLayout leads={leads} voiceDevice={voiceDevice} />}

          {activeNav === 'email' && <EmailPage />}

          {activeNav === 'timeline' && (
            <TimelinePage
              onContactClick={setCallsPagePhone}
              callsRefreshKey={callsRefreshKey}
            />
          )}

          {activeNav === 'contacts' && (
            <ContactsPage
              leads={leads}
              voiceDevice={voiceDevice}
              callsRefreshKey={callsRefreshKey}
            />
          )}

          {activeNav === 'admin' && currentUser?.is_owner && (
            <AdminPage />
          )}
        </main>
      </div>

      {/* Gradient fade mask — mobile only. Fades scrolled content into the
           near-white body (ink-950 = #f9fafb) so the floating nav pill
           reads cleanly above it. Height grows with safe-area so it always
           covers the nav pill + home indicator. */}
      <div
        className="md:hidden fixed bottom-0 left-0 right-0"
        style={{
          height: 'calc(96px + env(safe-area-inset-bottom))',
          zIndex: 39,
          pointerEvents: 'none',
          background: 'linear-gradient(to bottom, rgba(243,244,246,0) 0%, rgba(243,244,246,0.7) 50%, rgba(243,244,246,0.95) 100%)',
        }}
      />

      {/* Voice call error toast — shown when a call attempt fails from any page.
          Includes a Retry button so the user is never stuck after a Twilio
          token expires or a transient device error — refreshVoiceSession is
          deduplicated + active-call-safe so tapping Retry is always safe. */}
      {voiceDevice.status === 'failed' && voiceDevice.error && (
        <div className="fixed inset-x-0 top-16 z-50 flex justify-center px-4 pointer-events-none">
          <div className="w-full max-w-sm bg-red-50 border border-red-200 rounded-xl shadow-lg px-4 py-3 flex items-center gap-3 pointer-events-auto">
            <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="flex-1 text-sm text-red-700 font-medium">
              {t.appCallFailed}{voiceDevice.error}
            </p>
            <button
              type="button"
              onClick={voiceDevice.retryVoiceSession}
              className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg text-red-700 bg-white border border-red-200 hover:bg-red-100 transition-colors"
            >
              {t.appRetry || 'Retry'}
            </button>
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
                {voiceDevice.status === 'incoming' ? t.appIncomingCall : t.appConnected}
              </p>
              <p className="text-sm font-semibold text-gray-900 truncate">
                {voiceDevice.remoteIdentity || t.inboxUnknown}
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
          onSave={async (note, outcome) => {
            // Persist the note/outcome on the EXACT call row identified by
            // callSid (captured from the Twilio SDK at disconnect time). The
            // backend uses callSid to avoid mutating a previous call's row.
            try {
              await saveOutboundNote(
                voiceDevice.pendingPostCallNote.phone,
                note,
                outcome,
                voiceDevice.pendingPostCallNote.callSid || null,
              );
            } finally {
              invalidate('calls');
            }
          }}
          onClose={voiceDevice.clearPostCallNote}
        />
      )}

      {/* Contact history — triggered from Calls page */}
      {callsPagePhone && (
        <ContactHistoryModal
          phone={callsPagePhone}
          leads={leads}
          callsRefreshKey={callsRefreshKey}
          onClose={() => setCallsPagePhone(null)}
        />
      )}

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          contractorName={contractorName}
          businessName={businessName}
          onSave={handleProfileSave}
          language={language}
          onLanguageChange={handleLanguageChange}
          replyTranslation={replyTranslation}
          onReplyTranslationChange={handleReplyTranslationChange}
          push={push}
          isOwner={!!currentUser?.is_owner}
          onNavigateAdmin={() => { setSettingsOpen(false); handleNavChange('admin'); }}
        />
      )}

      {/* ── Bottom navigation — Figma spec.
           WHITE fully-rounded container (hairline border + soft shadow).
           Inactive tabs are bare gray icons. The active tab expands into a
           sage-green pill with icon + title-case label side by side. */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none"
           style={{
             paddingBottom: 'calc(env(safe-area-inset-bottom) + 8px)',
             paddingLeft: '16px',
             paddingRight: '16px',
             paddingTop: '8px',
           }}>
        {/* Figma "Nav bar": 358×54, white, 1px #ECECEC border, 2px padding */}
        <nav className="pointer-events-auto w-full max-w-[358px] h-[54px] nav-pill rounded-full flex items-center justify-between px-1">
          {/* Admin lives in Settings, not the bottom nav. Six items is the
               layout budget — the expanding active pill needs the room. */}
          {BOTTOM_NAV_ICONS.map(item => {
            const isActive = item.id === 'leads'
              ? activeNav === 'leads' || activeNav === 'overview'
              : activeNav === item.id;

            const newLeads = leads.filter(l => l.status === 'New').length;
            const badgeCount =
              item.id === 'calls'  ? callsBadge           :
              item.id === 'leads'  ? newLeads              :
              item.id === 'text'   ? remoteCounts.texts   :
              item.id === 'email'  ? remoteCounts.emails  :
              0;

            // Title-case label for the active pill ("Leads", not "LEADS")
            const rawLabel = t[item.id] || item.id;
            const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);

            return (
              <button
                key={item.id}
                onClick={() => handleNavChange(item.id)}
                className={`relative flex items-center justify-center transition-all duration-200 ease-out active:scale-[0.94]
                  ${isActive
                    ? 'gap-2 h-[46px] px-5 rounded-full bg-[#D6E4DC] text-[#065F46]'
                    : 'w-[46px] h-[46px] rounded-full text-[#344054]'
                  }`}
              >
                <div className="relative shrink-0">
                  {item.icon(isActive)}
                  {badgeCount > 0 && (
                    <span
                      className="absolute -top-1.5 -right-2.5 min-w-[18px] h-[18px] px-1
                                 bg-[#F04438] text-white text-[10px] font-bold rounded-full
                                 flex items-center justify-center leading-none pointer-events-none
                                 ring-2 ring-white tabular-nums"
                    >
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </div>
                {isActive && (
                  <span className="text-[15px] leading-none font-semibold whitespace-nowrap">
                    {label}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

    </div>
    </Sentry.ErrorBoundary>
  );
}
