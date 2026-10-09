// MUST stay the first import: captures and strips a Gmail completion handle
// from the URL before any other module (or Sentry) can see it.
import { sawGmailHandle, hasGmailReturn, getGmailError, scrubUrl } from './oauthReturn';
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import GmailConnectionView from './components/GmailConnectionView';
import { RefreshBusProvider } from './refreshBus';
import './index.css';

// ── Sentry frontend error tracking ──────────────────────────────────────────
// Only active when VITE_SENTRY_DSN is set (i.e. production builds on Vercel).
// Captures: JS exceptions, unhandled promise rejections, React render errors,
// and failed network requests via browserTracingIntegration.
if (import.meta.env.VITE_SENTRY_DSN) {
  // Never report query strings or fragments: media URLs carry a short-lived
  // ticket (?mt=), and the Gmail completion handle travels in a fragment. Console breadcrumbs
  // (raw log text) are dropped.
  const scrubData = (d) => {
    if (!d || typeof d !== 'object') return;
    for (const k of ['http.query', 'http.fragment', 'url.query', 'url.fragment']) delete d[k];
    // Any URL-valued field (url, from, to, http.url, url.full, lcp.url, …):
    // media tickets live in query strings, the Gmail handle in a fragment.
    for (const k of Object.keys(d)) {
      if (typeof d[k] === 'string' && /^(https?:)?\/\/|^\/[^/]/.test(d[k])) d[k] = scrubUrl(d[k]);
    }
  };
  const scrubEvent = (event) => {
    if (event?.request?.url) event.request.url = scrubUrl(event.request.url);
    if (typeof event?.transaction === 'string') event.transaction = scrubUrl(event.transaction);
    for (const sp of event?.spans || []) {
      if (typeof sp.description === 'string') sp.description = scrubUrl(sp.description);
      scrubData(sp.data);
    }
    if (Array.isArray(event?.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.filter(b => b?.category !== 'console');
    for (const b of event?.breadcrumbs || []) scrubData(b?.data);
    scrubData(event?.contexts?.trace?.data);
    return event;
  };
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,          // 'production' on Vercel
    tracesSampleRate: 1.0,                       // 100% while getting started — drop to 0.1 after a week
    integrations: [
      // instruments fetch + navigation. A page opened with a Gmail completion
      // handle skips the page-load span: Navigation Timing keeps the original
      // URL (with its fragment) even after the address bar is cleaned.
      Sentry.browserTracingIntegration({
        instrumentPageLoad: !sawGmailHandle(),
        // Recording/voicemail <audio> URLs carry a media ticket (?mt=).
        ignoreResourceSpans: ['resource.audio', 'resource.video'],
      }),
    ],
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: (b) => { if (b?.category === 'console') return null; scrubData(b?.data); return b; },
  });

  // Sentry user context is set dynamically in App.jsx once auth resolves
}

// ── Service Worker registration ───────────────────────────────────────────────
// Register early (before React mounts) so the SW is available when the push
// permission prompt fires. Safari on iOS requires the SW to be registered from
// the page — we do it unconditionally here so it's always ready.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch(err => console.warn('[SW] Registration failed:', err));
  });
}

// A return from the Gmail connection flow gets its own minimal screen instead
// of the app (no voice device, push, polling, onboarding or sign-up).
//  • connected → reload the app on the Email tab (?gmail_connected=1 is not a
//    "return" marker, so this cannot loop);
//  • an error return in a signed-in browser → switch to the app IN PLACE so the
//    Email tab shows the error banner (a reload would land here again);
//  • otherwise → reload the app at '/'.
function Root() {
  const [gmailReturn, setGmailReturn] = React.useState(() => hasGmailReturn());
  if (gmailReturn) {
    return (
      <GmailConnectionView
        onDone={(result) => {
          if (result?.connected) window.location.replace('/?gmail_connected=1');
          else if (result?.goEmail && getGmailError()) setGmailReturn(false);
          else window.location.replace('/');
        }}
      />
    );
  }
  return (
    <RefreshBusProvider>
      <App />
    </RefreshBusProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
