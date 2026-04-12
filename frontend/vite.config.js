import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
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
