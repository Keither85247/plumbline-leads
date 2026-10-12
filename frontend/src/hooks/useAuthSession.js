import { useState, useEffect, useCallback, useRef } from 'react';
import * as Sentry from '@sentry/react';
import { getMeStrict, logout, retryPendingLogout, hasPendingLogout, endOrphanedSession, accountDisabledSeen, AuthError } from '../api';
import { useVoiceDevice } from './useVoiceDevice';

/**
 * The signed-in account, and every way a sign-in can end.
 *
 *   cold start      /auth/me → signed in | signed out (session ended while the
 *                   app was closed) | server unreachable; a sign-out the server
 *                   never confirmed is retried instead of resuming the session
 *   explicit logout the server sign-out is reported honestly: local
 *                   credentials are always cleared, and if the server could not
 *                   confirm, the user is told and can retry
 *   forced sign-out a background 401 confirmed by /auth/me (expired, revoked,
 *                   signed out elsewhere), a 401 on the voice token, or a
 *                   suspended/blocked account
 *   account change  a different account signs in without a reload (here or in
 *                   another tab)
 *
 * On every path the Twilio Voice device is torn down FIRST, so the previous
 * account can never stay registered as client:user_<id>, ring, or place calls.
 * Each sign-in has an epoch: work started for one sign-in (a slow /auth/me
 * re-check) can never sign out a later one.
 *
 * Options:
 *   onSignedIn(user)   after a sign-in is accepted (cold start or login)
 *   onSignedOut(prev)  synchronously when an account's sign-in ends or changes,
 *                      before the next account renders — reset per-account state
 *   voiceAllowed(user) whether this user may have a Voice device right now
 *                      (e.g. not while a paywall or number picker is shown)
 *
 * notice: null | { kind: 'expired' | 'disabled' | 'offline'
 *                       | 'logout_unconfirmed' | 'logout_unverifiable' }
 */
export function useAuthSession({ onSignedIn, onSignedOut, voiceAllowed } = {}) {
  const [currentUser, setCurrentUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [notice, setNotice] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const userRef = useRef(null);
  const epochRef = useRef(0);
  const endingRef = useRef(false);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const onSignedOutRef = useRef(onSignedOut);
  onSignedOutRef.current = onSignedOut;
  const forceSignOutRef = useRef(null);
  const disabledRef = useRef(false);     // a 'disabled' reason arrived while a sign-out was already ending

  const voiceDevice = useVoiceDevice({
    onAuthLost: (code) => forceSignOutRef.current?.(code === 'ACCOUNT_DISABLED' ? 'disabled' : 'expired'),
  });
  const voiceRef = useRef(voiceDevice);
  voiceRef.current = voiceDevice;

  // Set (or clear) the signed-in user. Ending or changing an account tears
  // voice down and resets per-account state before anything renders for the
  // next one, and starts a new sign-in epoch.
  const applyUser = useCallback((user) => {
    const prev = userRef.current;
    const next = user || null;
    if (prev && (!next || prev.id !== next.id)) {
      voiceRef.current.teardown(next ? 'account_changed' : 'signed_out');
      try { onSignedOutRef.current?.(prev); } catch { /* reset is best effort */ }
    }
    if ((prev?.id ?? null) !== (next?.id ?? null)) epochRef.current += 1;
    userRef.current = next;
    setCurrentUser(next);
    Sentry.setUser(next ? { id: String(next.id) } : null);   // no email in error reports
  }, []);

  // Voice follows the signed-in account id (and the app's gates): on for it,
  // torn down when it changes, the user signs out, or the gate closes.
  // teardown is idempotent, so the explicit calls on each path below and this
  // cleanup never conflict.
  const userId = currentUser?.id ?? null;
  const allowed = !!currentUser && (voiceAllowed ? !!voiceAllowed(currentUser) : true);
  useEffect(() => {
    if (userId === null || !allowed) return undefined;
    voiceRef.current.initialize(userId);
    return () => voiceRef.current.teardown('session_changed');
  }, [userId, allowed]);

  // The session ended server-side: tear down, clean this device up, sign out.
  // Ignored if it belongs to an earlier sign-in (epoch) or one is already ending.
  // The reason shown is 'disabled' if ANY request of this sign-in was refused
  // as ACCOUNT_DISABLED (the server says so only once), else 'expired'.
  const forceSignOut = useCallback(async (reason, epoch = epochRef.current) => {
    if (reason === 'disabled' && endingRef.current) disabledRef.current = true;
    if (!userRef.current || endingRef.current || epoch !== epochRef.current) return;
    endingRef.current = true;
    disabledRef.current = reason === 'disabled';
    try {
      voiceRef.current.teardown(reason);
      const disabledBefore = accountDisabledSeen();     // logout() clears it with the local auth
      // The server already ended the session, so there is nothing to retry;
      // the call still removes this device's push registration when reachable.
      await logout({ markPendingOnFailure: false });
      if (epoch !== epochRef.current) return;
      const disabled = disabledRef.current || disabledBefore;
      applyUser(null);
      setNotice({ kind: disabled ? 'disabled' : 'expired' });
    } finally {
      endingRef.current = false;
    }
  }, [applyUser]);
  forceSignOutRef.current = forceSignOut;

  // A request was refused with 401. One background 401 is not trusted on its
  // own (a cold-start race right after login): /auth/me decides, and only a
  // definitive 401 for THIS sign-in signs out — a network error or 5xx leaves
  // the session, and a re-check that outlives its sign-in is ignored.
  const handleUnauthorized = useCallback(async (err) => {
    if (!userRef.current) return;
    const epoch = epochRef.current;
    if (err?.code === 'ACCOUNT_DISABLED' || accountDisabledSeen()) { await forceSignOut('disabled', epoch); return; }
    try {
      await getMeStrict();
    } catch (e) {
      if (e instanceof AuthError && epoch === epochRef.current) {
        await forceSignOut(e.code === 'ACCOUNT_DISABLED' ? 'disabled' : 'expired', epoch);
      }
    }
  }, [forceSignOut]);

  const outcomeNotice = ({ serverConfirmed, unverifiable, quiet }) => (
    serverConfirmed || quiet ? null : { kind: unverifiable ? 'logout_unverifiable' : 'logout_unconfirmed' }
  );

  const handleLogout = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setLoggingOut(true);
    try {
      voiceRef.current.teardown('logout');
      const result = await logout();
      applyUser(null);
      setNotice(outcomeNotice(result));
    } finally {
      setLoggingOut(false);
      endingRef.current = false;
    }
  }, [applyUser]);

  // "Try again" on the unconfirmed sign-out notice. A sign-in that happened
  // meanwhile wins: its credentials and state are left alone.
  const retryLogout = useCallback(async () => {
    const result = await retryPendingLogout();
    if (result.superseded || userRef.current) return result.serverConfirmed;
    setNotice(outcomeNotice(result));
    return result.serverConfirmed;
  }, []);

  const handleLoginSuccess = useCallback(async (user) => {
    setNotice(null);
    applyUser(user);            // a previous account's voice is torn down first
    await onSignedInRef.current?.(user);
  }, [applyUser]);

  // Same account, fresh fields (profile save, tester bypass): never a switch.
  // Accepts a user or an updater (prev => next).
  const updateUser = useCallback((next) => {
    const user = typeof next === 'function' ? next(userRef.current) : next;
    if (user === userRef.current) return;
    if (!user || !userRef.current || user.id !== userRef.current.id) { applyUser(user); return; }
    userRef.current = user;
    setCurrentUser(user);
  }, [applyUser]);

  // Cold start.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A sign-out the server never confirmed: finish it, and never resume
      // that session from its (possibly still valid) cookie.
      if (hasPendingLogout()) {
        voiceRef.current.teardown('pending_logout');
        const result = await retryPendingLogout();
        if (cancelled) return;
        setNotice(outcomeNotice(result));
        setAuthChecked(true);
        return;
      }

      let user = null;
      let ended = null;          // AuthError: the server said "not signed in"
      let reachable = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          user = await getMeStrict();
          reachable = true;
          break;
        } catch (err) {
          if (err instanceof AuthError) { ended = err; reachable = true; break; }
          // Likely Render cold-starting (or a 5xx during a deploy). Wait 4 s and
          // try once more before deciding; never treat this as a sign-out.
          if (attempt === 0) await new Promise(r => setTimeout(r, 4000));
        }
      }
      if (cancelled) return;

      if (!user) {
        voiceRef.current.teardown(ended ? 'cold_start_signed_out' : 'cold_start_unreachable');
        if (ended) {
          // The session ended while the app was closed (expired, revoked,
          // signed out elsewhere, suspended/blocked): clean this device up.
          let hadCredential = false;
          try { hadCredential = !!localStorage.getItem('plumbline_token') || !!localStorage.getItem('plumbline_fcm_token'); } catch { /* no storage */ }
          if (hadCredential) {
            const disabled = ended.code === 'ACCOUNT_DISABLED' || accountDisabledSeen();
            await logout({ markPendingOnFailure: false });
            if (cancelled) return;
            setNotice({ kind: disabled ? 'disabled' : 'expired' });
          }
        } else if (!reachable) {
          setNotice({ kind: 'offline' });
        }
      }
      applyUser(user);
      if (user) await onSignedInRef.current?.(user);
      if (!cancelled) setAuthChecked(true);
    })();
    return () => { cancelled = true; };
  }, [applyUser]);

  // Another tab signed in, switched account or signed out: this tab's UI,
  // voice identity and caches belong to the old sign-in — drop them and reload.
  useEffect(() => {
    async function onStorage(e) {
      if (e.key !== 'plumbline_token' && e.key !== null) return;
      voiceRef.current.teardown('other_tab_auth_change');
      // An old session this page still holds for a "Try again" is ended now
      // (briefly awaited) — the reload would forget it.
      await Promise.race([endOrphanedSession(), new Promise(r => setTimeout(r, 1500))]);
      try { window.location.reload(); } catch { /* not a browser */ }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return {
    currentUser,
    authChecked,
    notice,
    dismissNotice: () => setNotice(null),
    loggingOut,
    voiceDevice,
    handleLoginSuccess,
    handleLogout,
    handleUnauthorized,
    retryLogout,
    updateUser,
  };
}
