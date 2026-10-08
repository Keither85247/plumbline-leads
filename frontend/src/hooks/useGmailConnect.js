import { useCallback, useEffect, useRef, useState } from 'react';
import { startGmailConnect, getGmailAttempt, AuthError } from '../api';

// ── Start a Gmail connection ─────────────────────────────────────────────────
// 1. POST /auth/google/start (normal session) → single-use launch URL.
// 2. Open it top-level:
//    • web (desktop, Safari): a form POST, so the one-time ticket never sits in
//      the address bar or history;
//    • Android app: a GET navigation, which the WebView hands to the phone's
//      browser (Google does not allow sign-in inside an app WebView).
// 3. Google returns to the backend, which sends the browser to the app's
//    connection screen, where the signed-in user confirms (GmailConnectionView).
// In the Android app this hook then polls the attempt status so the app knows
// when the user has finished in the browser. Nothing here is logged or stored.

const isNativeApp = () => typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();

function openLaunch(launchUrl) {
  if (isNativeApp()) { window.location.assign(launchUrl); return; }
  const u = new URL(launchUrl);
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = u.origin + u.pathname;
  form.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 't';
  input.value = u.searchParams.get('t') || '';
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

const FAILURE_CODE = {
  access_denied:    'access_restricted',
  missing_scopes:   'missing_scopes',
  cancelled:        'oauth_cancelled',
  account_mismatch: 'account_mismatch',
  signed_in_other_account: 'signed_in_other_account',
  superseded:       'restart_required',
  callback_failed:  'callback_failed',
};
const POLL_MS = 3000;
const MAX_WAIT_MS = 25 * 60 * 1000;

/**
 * @param {{ onConnected?: () => void }} opts
 * @returns {{ state, begin, confirmOpen, checkNow, close }}
 *   state: null | { step: 'intro' | 'starting' } | { step: 'waiting', status } | { step: 'error', code }
 */
export function useGmailConnect({ onConnected } = {}) {
  const [state, setState] = useState(null);
  const inFlight = useRef(false);
  const generation = useRef(0);          // bumped by close()/begin(): a cancelled start never opens Google
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const confirmOpen = useCallback(async () => {
    if (inFlight.current) return;            // one attempt per click
    inFlight.current = true;
    const gen = ++generation.current;
    setState({ step: 'starting' });
    try {
      const url = await startGmailConnect();
      if (gen !== generation.current) { inFlight.current = false; return; }   // cancelled meanwhile
      if (isNativeApp()) {
        setState({ step: 'waiting', status: 'waiting_for_google' });
        inFlight.current = false;
      }
      // Web: the page is navigating away; keep the guard so a second tap cannot
      // start (and supersede) another attempt. A back/forward restore resets it.
      openLaunch(url);
    } catch (e) {
      inFlight.current = false;
      if (gen !== generation.current) return;
      setState({ step: 'error', code: e instanceof AuthError ? 'session_required' : (e.code || 'oauth_error') });
    }
  }, []);

  // Android app: explain the browser hand-off first; web goes straight to Google.
  const begin = useCallback(() => {
    if (isNativeApp()) setState({ step: 'intro' });
    else confirmOpen();
  }, [confirmOpen]);

  const checkNow = useCallback(async () => {
    try {
      const a = await getGmailAttempt();
      if (a.status === 'connected') { setState(null); onConnectedRef.current?.(); return; }
      if (a.status === 'failed')  { setState({ step: 'error', code: FAILURE_CODE[a.reason] || 'callback_failed' }); return; }
      if (a.status === 'expired' || a.status === 'none') { setState({ step: 'error', code: 'state_invalid' }); return; }
      setState(s => (s?.step === 'waiting' ? { step: 'waiting', status: a.status } : s));
    } catch (e) {
      if (e instanceof AuthError) setState({ step: 'error', code: 'session_required' });
    }
  }, []);

  // Back/forward-cache restore (e.g. swipe back from Google): the page was
  // never unloaded, so clear the "Opening Google…" state.
  useEffect(() => {
    const onShow = (e) => { if (e.persisted) { inFlight.current = false; setState(null); } };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  useEffect(() => {
    if (state?.step !== 'waiting') return undefined;
    const started = Date.now();
    const tick = () => {
      if (Date.now() - started > MAX_WAIT_MS) { setState({ step: 'error', code: 'state_invalid' }); return; }
      if (document.visibilityState === 'visible') checkNow();
    };
    const id = setInterval(tick, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') checkNow(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [state?.step, checkNow]);

  const close = useCallback(() => { generation.current++; inFlight.current = false; setState(null); }, []);
  return { state, begin, confirmOpen, checkNow, close };
}
