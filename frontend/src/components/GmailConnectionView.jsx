import { useEffect, useRef, useState } from 'react';
import { getMeStrict, login, logout, previewGmailCompletion, completeGmailConnection, getGmailAttempt, AuthError, AUTH_BASE } from '../api';
import { getGmailHandle, clearGmailHandle, getGmailError, clearGmailError, sawGmailHandle } from '../oauthReturn';
import { gmailErrorCopy } from '../gmailCopy';

// ── Gmail connection return screen ───────────────────────────────────────────
// Rendered by main.jsx INSTEAD of <App/> when the page was opened by the Gmail
// connection flow, so the voice device, push, polling, onboarding and sign-up
// never start here. The signed-in account must be the one that started the attempt,
// and the user must explicitly confirm the Google address before it is
// connected. On Android the flow finishes in the phone's browser: the user signs
// in here, confirms, and that temporary sign-in is removed again afterwards.

function Shell({ children }) {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
        <p className="text-xs font-semibold tracking-wide text-gray-400 uppercase mb-3">Plumbline Leads · Gmail</p>
        {children}
      </div>
    </div>
  );
}

// Non-secret marker: "the sign-in in this browser was made only to finish a
// Gmail connection" — so another tab of this screen (e.g. after "Start over")
// still treats it as temporary and removes it.
const TEMP_MARK = 'plumbline_gmail_temp_signin';
const storageGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const storageSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* no storage */ } };

const btn  = 'w-full rounded-xl py-2.5 text-sm font-semibold transition-colors disabled:opacity-50';
const prim = `${btn} bg-gray-900 text-white hover:bg-gray-800`;
const sec  = `${btn} border border-gray-200 text-gray-700 hover:bg-gray-50`;

export default function GmailConnectionView({ onDone }) {
  const [phase, setPhase]         = useState('checking');
  const [user, setUser]           = useState(null);
  const [googleEmail, setGoogle]  = useState(null);
  const [errorCode, setErrorCode] = useState(null);
  const [form, setForm]           = useState({ email: '', password: '' });
  const [formError, setFormError] = useState(null);
  const [busy, setBusy]           = useState(false);
  // Did this browser already hold a real Plumbline sign-in? (Presence only —
  // the value is never read.) A sign-in left by an earlier Gmail screen counts
  // as temporary, not real.
  const startedTemp = !!storageGet('plumbline_token') && storageGet(TEMP_MARK) === '1';
  const hadSession = useRef(!!storageGet('plumbline_token') && !startedTemp);
  const [signedInHere, setSignedInHere] = useState(startedTemp);  // a temporary sign-in is in use (e.g. Android's browser)
  const tempSession = useRef(startedTemp);
  const completeSent = useRef(false);    // a Connect request may have succeeded without us seeing the reply
  const [attemptKey, setAttemptKey] = useState(0);         // "Try again" after a network error

  // A sign-in made only to finish the connection is removed again afterwards.
  // The logout promise is kept so every exit waits for it to finish.
  const logoutPending = useRef(null);
  const finishTemp = () => {
    if (tempSession.current) {
      tempSession.current = false;
      logoutPending.current = logout().catch(() => {}).then(() => storageSet(TEMP_MARK, null));
    }
    return logoutPending.current || Promise.resolve();
  };

  // Leaving the page with a temporary sign-in still active (tab closed or
  // navigated away): forget the stored token now and end the server session
  // best-effort (a cookie-only request needs no preflight, so it can be sent
  // while the page unloads).
  useEffect(() => {
    const onHide = () => {
      if (!tempSession.current) return;
      storageSet('plumbline_token', null);
      storageSet(TEMP_MARK, null);
      try { fetch(`${AUTH_BASE}/logout`, { method: 'POST', credentials: 'include', keepalive: true }); } catch { /* best effort */ }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  async function loadPreview(me) {
    const handle = getGmailHandle();
    if (!handle) { setErrorCode('state_invalid'); setPhase('error'); return; }
    try {
      const { googleEmail: g } = await previewGmailCompletion(handle);
      setGoogle(g || null);
      setUser(me);
      setPhase('confirm');
    } catch (e) {
      if (e instanceof AuthError) { setPhase('signin'); return; }
      if (e.code === 'account_mismatch') { setUser(me); setPhase('mismatch'); return; }
      // Network error or server hiccup: the result is still valid on the
      // server for a few minutes — keep the handle and offer "Try again".
      if (!e.status || e.status >= 500) { setPhase('offline'); return; }
      // A Connect whose reply was lost may in fact have succeeded.
      if (completeSent.current && e.status === 410) {
        try {
          const a = await getGmailAttempt();
          if (a.status === 'connected') { clearGmailHandle(); await finishTemp(); setUser(me); setPhase('success'); return; }
        } catch { /* fall through */ }
      }
      clearGmailHandle();
      await finishTemp();
      setErrorCode(e.code === 'too_many_attempts' ? 'too_many_attempts' : 'state_invalid');
      setPhase('error');
    }
  }

  // Signed in? null = definitely not; throws = could not check (retried once,
  // then a "Try again" screen — never mistaken for a signed-out browser).
  async function checkSession() {
    for (let i = 0; i < 2; i++) {
      try { return { me: await getMeStrict() }; }
      catch (e) {
        if (e instanceof AuthError) return { me: null };
        if (i === 0) await new Promise(r => setTimeout(r, 3000));
      }
    }
    return { offline: true };
  }

  useEffect(() => {
    let cancelled = false;
    setPhase('checking');
    (async () => {
      const r = await checkSession();
      if (cancelled) return;
      if (r.offline) { setPhase('offline'); return; }
      const me = r.me;
      if (!sawGmailHandle()) {
        // An error return. In a browser where the app is signed in, let the
        // Email page show it; elsewhere (Android's browser) explain here.
        if (me) { onDone({ goEmail: true }); return; }
        setErrorCode(getGmailError() || 'oauth_error');
        setPhase('error');
        return;
      }
      if (!me) { setPhase('signin'); return; }
      await loadPreview(me);
    })();
    return () => { cancelled = true; };
  }, [attemptKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSignIn(e) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const me = await login(form.email.trim(), form.password);
      tempSession.current = !hadSession.current;
      setSignedInHere(!hadSession.current);
      if (!hadSession.current) storageSet(TEMP_MARK, '1');
      setForm({ email: '', password: '' });
      await loadPreview(me);
    } catch (err) {
      setFormError(err.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    tempSession.current = false;
    setSignedInHere(false);
    await logout().catch(() => {});
    storageSet(TEMP_MARK, null);
    setUser(null);
    setPhase('signin');
  }

  async function decide(confirm) {
    const handle = getGmailHandle();
    if (!handle || busy) return;
    setBusy(true);
    let next;
    try {
      const r = await completeGmailConnection(handle, confirm);
      clearGmailHandle();
      next = r.cancelled ? 'cancelled' : 'success';
    } catch (e) {
      if (e instanceof AuthError) { setBusy(false); setPhase('signin'); return; }
      if (!e.status || e.status >= 500 && e.code !== 'callback_failed') {
        if (confirm) completeSent.current = true;
        setBusy(false); setPhase('offline'); return;
      }
      clearGmailHandle();
      setErrorCode(e.code === 'account_mismatch' ? 'account_mismatch' : (e.code || 'callback_failed'));
      next = 'error';
    }
    // Sign out a temporary sign-in BEFORE showing the result, so leaving the
    // page can never interrupt it.
    await finishTemp();
    setBusy(false);
    setPhase(next);
  }

  // Every exit removes a sign-in that was made only to finish the connection.
  const leave = async (result) => { await finishTemp(); if (!result?.goEmail) clearGmailError(); onDone(result); };
  const wasTemp = signedInHere;

  if (phase === 'checking') {
    return <Shell><p className="text-sm text-gray-500">Checking your Gmail connection…</p></Shell>;
  }

  if (phase === 'offline') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">Can't reach Plumbline Leads</h1>
        <p className="text-sm text-gray-500 mt-2">Check your connection and try again. Your Gmail connection is kept for a few minutes.</p>
        <button onClick={() => setAttemptKey(k => k + 1)} className={`${prim} mt-5`}>Try again</button>
      </Shell>
    );
  }

  if (phase === 'signin') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">Finish connecting Gmail</h1>
        <p className="text-sm text-gray-500 mt-2">
          Sign in with the <strong>same Plumbline Leads account</strong> you were using in the app.
          Never sign in with an email and password that someone else sent you.
        </p>
        <form onSubmit={handleSignIn} className="mt-4 space-y-3">
          <input type="email" autoComplete="username" required placeholder="Email"
            value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm" />
          <input type="password" autoComplete="current-password" required placeholder="Password"
            value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm" />
          {formError && <p role="alert" className="text-xs text-red-600">{formError}</p>}
          <button type="submit" disabled={busy} className={prim}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="text-xs text-gray-400 mt-4">Can't sign in? Go back to the app and try again from a computer.</p>
      </Shell>
    );
  }

  if (phase === 'mismatch') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">Different account signed in</h1>
        <p className="text-sm text-gray-500 mt-2">
          This Gmail connection was started from a different Plumbline Leads account than the one signed in here
          {user?.email ? <> (<span className="font-medium text-gray-700">{user.email}</span>)</> : null}.
        </p>
        <div className="mt-5 space-y-2">
          <button onClick={handleSignOut} className={prim}>Sign out and use the right account</button>
          <button onClick={() => { clearGmailHandle(); leave({}); }} className={sec}>Not now</button>
        </div>
      </Shell>
    );
  }

  if (phase === 'confirm') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">Connect this Gmail account?</h1>
        <p className="text-sm text-gray-600 mt-3">
          Gmail: <span className="font-semibold text-gray-900 break-all">{googleEmail || 'your Google account'}</span>
        </p>
        <p className="text-sm text-gray-600 mt-1">
          Plumbline Leads account: <span className="font-semibold text-gray-900 break-all">{user?.email}</span>
        </p>
        <p className="text-xs text-gray-400 mt-3">Only continue if you just tapped Connect Gmail yourself.</p>
        <div className="mt-5 space-y-2">
          <button onClick={() => decide(true)} disabled={busy} className={prim}>{busy ? 'Connecting…' : 'Connect Gmail'}</button>
          <button onClick={() => decide(false)} disabled={busy} className={sec}>Cancel</button>
        </div>
      </Shell>
    );
  }

  if (phase === 'success') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">Gmail connected</h1>
        {wasTemp ? (
          <p className="text-sm text-gray-500 mt-2">You can close this page and switch back to the Plumbline Leads app.</p>
        ) : (
          <button onClick={() => leave({ connected: true })} className={`${prim} mt-5`}>Continue to Plumbline Leads</button>
        )}
      </Shell>
    );
  }

  if (phase === 'cancelled') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">Gmail was not connected</h1>
        {wasTemp
          ? <p className="text-sm text-gray-500 mt-2">You can close this page and switch back to the Plumbline Leads app.</p>
          : <button onClick={() => leave({ goEmail: true })} className={`${sec} mt-5`}>Continue to Plumbline Leads</button>}
      </Shell>
    );
  }

  // error
  const copy = gmailErrorCopy(errorCode);
  return (
    <Shell>
      <h1 className="text-base font-semibold text-gray-900">{copy.title}</h1>
      <p className="text-sm text-gray-500 mt-2">{copy.body}</p>
      <p className="text-xs text-gray-400 mt-3">If you were using the Plumbline Leads app, return to it and tap Connect Gmail to try again.</p>
      <button onClick={() => leave({})} className={`${sec} mt-5`}>Continue to Plumbline Leads</button>
    </Shell>
  );
}
