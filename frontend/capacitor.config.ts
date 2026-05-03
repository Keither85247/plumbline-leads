import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.plumblineleads.app',
  appName: 'Plumbline Leads',
  webDir: 'dist',

  server: {
    // Use HTTPS scheme so getUserMedia / WebRTC works inside the WebView.
    // Capacitor maps this to a local asset server on device.
    androidScheme: 'https',
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
