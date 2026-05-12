// Refresh bus — small, intentional, and not Redux.
//
// Why this exists
// ---------------
// The app had grown several independent data-refresh paths:
//   • App.jsx maintained callsRefreshKey state, bumped on voiceDevice.status
//     and after saveOutboundNote, threaded through props into CallsPage,
//     ContactsPage, TimelinePage, ContactHistoryModal.
//   • App.jsx added separate visibilitychange + focus + 30s + tab-activation
//     triggers for the Leads list.
//   • useVoiceDevice has its own visibility/focus listeners for Twilio
//     session recovery (different concern — left alone).
//   • InboxLayout polls conversations and the thread internally.
//
// This module centralises the data-refresh pattern without pulling in a
// state-management library. It's a tiny React context with:
//
//   • a `versions` map keyed by named data domains (leads, calls, ...)
//   • an `invalidate(key)` function that bumps the version for that key
//     (or every key when called with 'all')
//   • one global listener for visibilitychange→visible and window focus
//     that calls invalidate('all') so every feature gets a fresh fetch on
//     app foreground / tab return — no per-feature focus listeners needed.
//
// Consumers
// ---------
//   const leadsVersion = useRefreshKey('leads');
//   useEffect(() => { fetchLeads(); }, [leadsVersion]);
//
//   const invalidate = useInvalidate();
//   invalidate('calls');    // bump just the calls key
//   invalidate('all');      // bump every key
//
// What this is NOT
// ----------------
// Not a cache. Not a query library. The bus only signals "you should
// refetch"; each component still owns its own fetch logic and state.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const REFRESH_KEYS = ['leads', 'calls', 'messages', 'contacts', 'timeline'];

const RefreshBusContext = createContext(null);

function makeInitial() {
  const o = {};
  for (const k of REFRESH_KEYS) o[k] = 0;
  return o;
}

export function RefreshBusProvider({ children }) {
  const [versions, setVersions] = useState(makeInitial);

  const invalidate = useCallback((key) => {
    if (key === 'all') {
      setVersions(prev => {
        const next = { ...prev };
        for (const k of REFRESH_KEYS) next[k] = (prev[k] || 0) + 1;
        return next;
      });
      return;
    }
    if (!REFRESH_KEYS.includes(key)) {
      // Fail loud in development so a typo doesn't silently no-op.
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn('[refreshBus] unknown key:', key);
      }
      return;
    }
    setVersions(prev => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
  }, []);

  // Global foreground listener — covers app resume on Capacitor (visibility)
  // and desktop tab refocus (focus). Replaces per-feature listeners that were
  // previously scattered across App.jsx. Calling invalidate('all') re-runs
  // every consumer's fetch effect exactly once.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') invalidate('all');
    };
    const onFocus = () => invalidate('all');
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [invalidate]);

  const value = useMemo(() => ({ versions, invalidate }), [versions, invalidate]);

  return (
    <RefreshBusContext.Provider value={value}>
      {children}
    </RefreshBusContext.Provider>
  );
}

function useBus() {
  const ctx = useContext(RefreshBusContext);
  if (!ctx) {
    throw new Error('useRefreshKey / useInvalidate must be used inside <RefreshBusProvider>');
  }
  return ctx;
}

/** Returns the current version integer for `key`. Bumps when invalidate(key)
 *  (or invalidate('all')) is called. Use as a useEffect dependency. */
export function useRefreshKey(key) {
  const { versions } = useBus();
  return versions[key] ?? 0;
}

/** Returns the stable invalidate function. */
export function useInvalidate() {
  return useBus().invalidate;
}
