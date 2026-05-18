import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { execSync } from 'node:child_process';

// ── Build-time version metadata ──────────────────────────────────────────────
// Injected into the bundle so the running app can show what version it is.
// Critical for debugging when "browser shows X, phone shows Y" — the visible
// Build Info in Settings tells you whether the device loaded a stale bundle,
// a different deploy, or the wrong asset hashes.
//
// Source priority:
//   1. VERCEL_GIT_COMMIT_SHA — set automatically on every Vercel build
//   2. `git rev-parse` — works for local builds (capacitor sync, etc.)
//   3. 'unknown' — last-resort fallback (CI without git, sandbox builds)
function safeGit(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}
const COMMIT_SHA  = (process.env.VERCEL_GIT_COMMIT_SHA || safeGit('git rev-parse HEAD') || 'unknown').slice(0, 12);
const BUILD_TIME  = new Date().toISOString();
const BUILD_BRANCH = process.env.VERCEL_GIT_COMMIT_REF || safeGit('git rev-parse --abbrev-ref HEAD') || 'unknown';

export default defineConfig({
  // Expose build metadata as compile-time replacements. Components read these
  // via import.meta.env.VITE_BUILD_* — Vite inlines them at build, so the
  // bundle itself encodes which commit it came from. Capacitor's bundled dist
  // and the live Vercel deploy will carry different values when out of sync.
  define: {
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(COMMIT_SHA),
    'import.meta.env.VITE_BUILD_TIME':   JSON.stringify(BUILD_TIME),
    'import.meta.env.VITE_BUILD_BRANCH': JSON.stringify(BUILD_BRANCH),
  },

  plugins: [
    react(),
    // Uploads source maps to Sentry so stack traces in error reports are
    // readable instead of minified. Requires SENTRY_AUTH_TOKEN, SENTRY_ORG,
    // and SENTRY_PROJECT to be set in Vercel environment variables.
    // If those vars are absent the plugin is a no-op — build still succeeds.
    sentryVitePlugin({
      org:       process.env.SENTRY_ORG,
      project:   process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: {
        // Upload maps then delete them so they aren't shipped to the browser
        filesToDeleteAfterUpload: ['./dist/**/*.js.map'],
      },
      telemetry: false,
      silent: !process.env.SENTRY_AUTH_TOKEN, // quiet when vars aren't set
    }),
  ],

  // Emit source maps so Sentry can upload them during the build
  build: {
    sourcemap: true,
  },

  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // OAuth flow: /auth/google redirects to Google; /auth/google/callback returns here
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
