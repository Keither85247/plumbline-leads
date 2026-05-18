import { useState, useEffect } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Build Info & Cache-Bust panel
// ─────────────────────────────────────────────────────────────────────────────
//
// Why this exists:
//   Without a visible build label, "browser shows new UI, phone shows old UI"
//   is impossible to diagnose remotely — Vite hashed bundles, WebView HTTP
//   cache, Capacitor bundled-dist fallback, and the live server.url all
//   conspire to make divergence invisible.
//
// What it shows:
//   • COMMIT — the short git SHA the bundle was built from (injected at
//     build-time by vite.config.js via import.meta.env.VITE_BUILD_COMMIT).
//     Compare to the latest commit on main to know if the bundle is fresh.
//   • BUILT — ISO timestamp of the build. Tells you bundle age at a glance.
//   • SOURCE — the origin the bundle was loaded from (e.g.
//     "https://plumbline-leads.vercel.app" when Capacitor live mode worked,
//     "https://localhost" or "file://" when the bundled dist/ inside the APK
//     is being served instead). This is the smoking gun for live-mode failure.
//   • RUNTIME — "Capacitor (Android)" / "Capacitor (iOS)" / "Browser" so we
//     can tell the platform at a glance.
//
// What the Hard Refresh button does:
//   1. Unregisters any service workers (safety — even our push-only SW could
//      pin a stale page in theory).
//   2. Deletes every Cache Storage entry (in case the SW ever did cache).
//   3. Reloads the page with a cache-busting query string so the WebView's
//      HTTP cache is forced to revalidate the HTML, which pulls fresh asset
//      hashes, which pull fresh JS/CSS.
//
//   It's safe to tap any time — no data loss, just a forced fresh fetch.
// ─────────────────────────────────────────────────────────────────────────────

function getRuntime() {
  if (typeof window === 'undefined') return 'SSR';
  // Capacitor injects window.Capacitor when running inside the native shell.
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) {
    const platform = cap.getPlatform?.() || 'native';
    return `Capacitor (${platform})`;
  }
  return 'Browser';
}

function getSource() {
  if (typeof window === 'undefined') return '';
  const { protocol, host } = window.location;
  // file:// or capacitor:// → bundled dist/ inside the APK
  // https://<vercel-domain> → live Vercel deploy via server.url
  return `${protocol}//${host}`;
}

function formatBuildTime(iso) {
  if (!iso || iso === 'unknown') return 'unknown';
  try {
    const d = new Date(iso);
    // Compact, locale-independent: "May 17, 22:09"
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

async function hardRefresh() {
  // 1. Unregister all service workers so a stale SW can't re-cache the page
  //    we're about to fetch fresh.
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch {} // best-effort — never block the refresh

  // 2. Nuke Cache Storage entries (SW caches + any code-cached responses).
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
  } catch {}

  // 3. Reload with a cache-busting query string. WebView treats this as a
  //    different URL than what's in its HTTP cache, so it does a fresh
  //    network fetch instead of serving the stale entry.
  const bust = `_v=${Date.now()}`;
  const url  = new URL(window.location.href);
  url.searchParams.set('_v', String(Date.now())); // overwrites if present
  // location.replace so the user can't "back" to the stale URL.
  window.location.replace(url.toString());
}

export default function BuildInfoPanel() {
  // Read injected metadata. Vite replaces these literals at build time, so
  // the bundle itself carries the answer — no network round-trip needed.
  const commit = import.meta.env.VITE_BUILD_COMMIT || 'dev';
  const time   = import.meta.env.VITE_BUILD_TIME   || 'dev';
  const branch = import.meta.env.VITE_BUILD_BRANCH || 'dev';

  const [runtime, setRuntime] = useState('');
  const [source,  setSource]  = useState('');
  const [copied,  setCopied]  = useState(false);

  // Defer to first paint so window.Capacitor has had a chance to land.
  useEffect(() => {
    setRuntime(getRuntime());
    setSource(getSource());
  }, []);

  // Detect a likely divergence: Capacitor running but source is bundled
  // (not the live Vercel domain). Highlight in amber so it's not missed.
  const looksBundled = runtime.startsWith('Capacitor') &&
    !source.includes('vercel.app') &&
    !source.includes('https://');

  const handleCopy = async () => {
    const blob = [
      `commit:  ${commit}`,
      `branch:  ${branch}`,
      `built:   ${time}`,
      `source:  ${source}`,
      `runtime: ${runtime}`,
      `ua:      ${navigator.userAgent}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {} // clipboard may be blocked in some WebViews
  };

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Build info
      </label>
      <div className={`rounded-lg border px-3 py-3 space-y-1.5 ${
        looksBundled
          ? 'bg-amber-50 border-amber-200'
          : 'bg-gray-50 border-gray-200'
      }`}>
        <Row label="Commit"  value={commit}  mono />
        <Row label="Branch"  value={branch}  mono />
        <Row label="Built"   value={formatBuildTime(time)} />
        <Row label="Source"  value={source}  mono />
        <Row label="Runtime" value={runtime} />

        {looksBundled && (
          <p className="text-[11px] text-amber-700 leading-snug pt-1 border-t border-amber-200">
            ⚠️ Running bundled assets inside the app, not the live Vercel
            build. Rebuild &amp; reinstall the APK to switch to live mode.
          </p>
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={hardRefresh}
            className="flex-1 text-xs font-semibold bg-gray-900 text-white rounded-lg py-1.5 hover:bg-gray-800 transition-colors"
          >
            Hard refresh
          </button>
          <button
            onClick={handleCopy}
            className="text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition-colors"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Compact key/value row. `mono` flag enables tabular font for hashes/URLs
// so they don't visually shift between rows.
function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-gray-500 uppercase tracking-wide shrink-0">{label}</span>
      <span className={`text-gray-800 text-right truncate ${mono ? 'font-mono tabular-nums' : ''}`}
            title={value}>
        {value || '—'}
      </span>
    </div>
  );
}
