import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.plumblineleads.app',
  appName: 'Plumbline Leads',
  webDir: 'dist',

  server: {
    // Use HTTPS scheme so getUserMedia / WebRTC works inside the WebView.
    // Capacitor maps this to a local asset server on device.
    androidScheme: 'https',

    // LIVE MODE — the APK loads the React app from production on every
    // launch instead of bundling dist/ into the APK. Trade-offs:
    //   ✅ Frontend pushes (Vercel deploys) go live to users immediately
    //      — no rebuild, no Play Store review cycle
    //   ✅ Faster iteration on UI bugs and copy changes
    //   ⚠️  App needs network on cold launch (no offline first-paint)
    //   ⚠️  Native plugin changes (push, Twilio SDK, etc.) STILL require
    //      a rebuild + reupload — only the React frontend is live
    //   ⚠️  Play Store reviewers occasionally flag remote-loaded apps;
    //      if rejected, comment out the `url` line, rebuild, and ship
    //      the bundled version
    //
    // Disable for offline-capable builds by commenting out `url`.
    url: 'https://plumbline-leads.vercel.app',

    // cleartext is false (HTTPS only) — keeps the app secure and matches
    // the production frontend's scheme. Don't flip this on without a
    // very good reason; it opens the door to mixed-content attacks.
    cleartext: false,
  },

  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#111827', // gray-900 matches app theme
      showSpinner: false,
    },
  },
};

export default config;
