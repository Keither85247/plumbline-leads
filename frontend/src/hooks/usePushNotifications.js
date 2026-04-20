import { useState, useEffect, useCallback } from 'react';
import { getVapidPublicKey, savePushSubscription, deletePushSubscription } from '../api';

/** Convert a base64url VAPID public key to a Uint8Array for PushManager. */
function urlBase64ToUint8Array(base64String) {
  const padding  = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64   = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData  = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

const SW_PATH = '/sw.js';

/**
 * Hook that manages Web Push subscription lifecycle.
 *
 * Returns:
 *   supported     — browser supports push (false on older iOS / non-Safari)
 *   permission    — 'default' | 'granted' | 'denied'
 *   subscribed    — true if device is actively subscribed
 *   subscribing   — async operation in flight
 *   subscribe()   — request permission + subscribe
 *   unsubscribe() — cancel subscription
 */
export function usePushNotifications() {
  const supported = typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager'   in window
    && 'Notification'  in window;

  const [permission,   setPermission]   = useState(supported ? Notification.permission : 'denied');
  const [subscribed,   setSubscribed]   = useState(false);
  const [subscribing,  setSubscribing]  = useState(false);
  const [error,        setError]        = useState(null);

  // Check existing subscription on mount
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then(reg =>
      reg.pushManager.getSubscription()
    ).then(sub => {
      setSubscribed(!!sub);
    }).catch(() => {});
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported || subscribing) return;
    setSubscribing(true);
    setError(null);
    try {
      // 1. Register (or reuse) service worker
      let reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      if (!reg) reg = await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
      await navigator.serviceWorker.ready;

      // 2. Request notification permission
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return;

      // 3. Get VAPID public key from backend
      const publicKey = await getVapidPublicKey();

      // 4. Subscribe via PushManager
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // 5. Save subscription on backend
      await savePushSubscription(sub.toJSON());
      setSubscribed(true);
    } catch (err) {
      console.error('[Push] Subscribe failed:', err);
      setError(err.message || 'Failed to enable notifications');
    } finally {
      setSubscribing(false);
    }
  }, [supported, subscribing]);

  const unsubscribe = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await deletePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      console.error('[Push] Unsubscribe failed:', err);
    }
  }, []);

  return { supported, permission, subscribed, subscribing, error, subscribe, unsubscribe };
}
