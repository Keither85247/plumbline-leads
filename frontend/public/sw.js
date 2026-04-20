// PlumbLine Leads — Service Worker
// Handles Web Push notifications and notification-click navigation.
// Served from /sw.js (Vite passes through /public unchanged).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Push event ────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}

  const { title = 'PlumbLine Leads', body = '', tag, url = '/' } = data;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag:               tag || 'plumbline',
      data:              { url },
      requireInteraction: false,
      silent:            false,
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Focus an existing window if one is open
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        // Otherwise open a new window
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      })
  );
});
