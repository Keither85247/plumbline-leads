/**
 * useCapacitorPush — FCM push notifications for the Android (Capacitor) app.
 *
 * On native Android the Web Push API is not available inside the WebView, so
 * we use @capacitor/push-notifications which routes through Firebase Cloud
 * Messaging (FCM) instead.
 *
 * Flow:
 *   1. Request permission from Android (POST_NOTIFICATIONS, Android 13+).
 *   2. Get the FCM device token from the Capacitor plugin.
 *   3. POST the token to /api/push/fcm-subscribe so the backend can send
 *      FCM pushes to this device.
 *   4. Listen for push events and surface them inside the app if it's open.
 *
 * The backend must have Firebase Admin SDK configured (see ANDROID_RELEASE.md).
 */

import { useEffect, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { API_BASE } from '../api';

// Lazy-load the Capacitor plugin so the web bundle never imports native code.
async function getPushPlugin() {
  const { PushNotifications } = await import('@capacitor/push-notifications');
  return PushNotifications;
}

export function useCapacitorPush({ onNotification } = {}) {
  const registered = useRef(false);

  const sendTokenToBackend = useCallback(async (token) => {
    try {
      const storedToken = localStorage.getItem('plumbline_token');
      const headers = { 'Content-Type': 'application/json' };
      if (storedToken) headers['Authorization'] = `Bearer ${storedToken}`;

      await globalThis.fetch(`${API_BASE}/push/fcm-subscribe`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ fcmToken: token }),
      });
      console.log('[CapacitorPush] FCM token registered with backend');
    } catch (err) {
      console.error('[CapacitorPush] Failed to send FCM token to backend:', err);
    }
  }, []);

  useEffect(() => {
    // Only run on native Android — silently skip on web/iOS
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
    if (registered.current) return;
    registered.current = true;

    let PushNotifications;

    (async () => {
      try {
        PushNotifications = await getPushPlugin();

        // Request permission
        const permResult = await PushNotifications.requestPermissions();
        if (permResult.receive !== 'granted') {
          console.warn('[CapacitorPush] Notification permission denied');
          return;
        }

        // Register with FCM
        await PushNotifications.register();

        // Token received — send to backend
        PushNotifications.addListener('registration', (token) => {
          console.log('[CapacitorPush] FCM token received');
          sendTokenToBackend(token.value);
        });

        PushNotifications.addListener('registrationError', (err) => {
          console.error('[CapacitorPush] Registration error:', err.error);
        });

        // Push received while app is open — surface it in the app
        PushNotifications.addListener('pushNotificationReceived', (notification) => {
          console.log('[CapacitorPush] Push received (foreground):', notification);
          if (onNotification) onNotification(notification);
        });

        // User tapped a notification — navigate to the right screen
        PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const url = action.notification.data?.url;
          console.log('[CapacitorPush] Notification tapped, url:', url);
          if (url && url !== '/') {
            // React Router is not used, so set the hash or reload to the path
            // The app reads ?tab= from the URL query string
            window.location.search = url.replace(/^\//, '');
          }
        });
      } catch (err) {
        console.error('[CapacitorPush] Setup error:', err);
      }
    })();

    return () => {
      // Listeners are cleaned up automatically when the app unloads
    };
  }, [sendTokenToBackend, onNotification]);
}
