import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './index.css';

// ── Sentry frontend error tracking ──────────────────────────────────────────
// Only active when VITE_SENTRY_DSN is set (i.e. production builds on Vercel).
// Captures: JS exceptions, unhandled promise rejections, React render errors,
// and failed network requests via browserTracingIntegration.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,          // 'production' on Vercel
    tracesSampleRate: 1.0,                       // 100% while getting started — drop to 0.1 after a week
    integrations: [
      Sentry.browserTracingIntegration(),        // instruments fetch + navigation
    ],
  });

  // Sentry user context is set dynamically in App.jsx once auth resolves
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
