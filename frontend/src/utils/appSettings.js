import { Capacitor, registerPlugin } from '@capacitor/core';

// Bridge to the tiny AppSettingsPlugin registered in MainActivity.java.
// One method: open() → launches Android's App Info page for this app
// (ACTION_APPLICATION_DETAILS_SETTINGS + package: URI), where the user can
// flip the Microphone permission — including after "Don't ask again".
const AppSettings = registerPlugin('AppSettings');

export function isNativeAndroid() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

// The app runs in Capacitor live mode (server.url → deployed frontend), so
// an APK built before AppSettingsPlugin existed loads THIS JS without the
// native side. isPluginAvailable keeps the Open Settings button off those
// installs instead of rendering a button that can't work.
export function canOpenAppSettings() {
  return isNativeAndroid() && Capacitor.isPluginAvailable('AppSettings');
}

export async function openAppSettings() {
  if (!canOpenAppSettings()) return false;
  try {
    await AppSettings.open();
    return true;
  } catch (err) {
    console.warn('[AppSettings] open failed', { message: err?.message });
    return false;
  }
}
