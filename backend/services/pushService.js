'use strict';
/**
 * Web Push delivery service.
 *
 * Sends push notifications to all subscribed devices for a user.
 * Requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_EMAIL env vars.
 * Silently no-ops when those vars are absent (no push configured yet).
 *
 * Dead subscriptions (410 / 404 from the push service) are pruned automatically.
 */

const webpush = require('web-push');
const db      = require('../db');
const log     = require('../logger').for('Push');

const configured = !!(
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY
);

if (configured) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@plumblineleads.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  log.info('VAPID configured — push notifications enabled');
} else {
  log.warn('VAPID keys not set — push notifications disabled');
}

/**
 * Send a push notification to all subscriptions for the given userId.
 * Pass userId = null to broadcast to all subscriptions (used by webhook paths
 * where the user id isn't known at call time).
 *
 * @param {number|null} userId
 * @param {{ title: string, body: string, tag?: string, url?: string }} payload
 */
async function sendPush(userId, payload) {
  if (!configured) return;

  const subs = userId == null
    ? db.prepare('SELECT * FROM push_subscriptions').all()
    : db.prepare(
        'SELECT * FROM push_subscriptions WHERE user_id = ? OR user_id IS NULL'
      ).all(userId);

  if (subs.length === 0) return;

  const results = await Promise.allSettled(
    subs.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 } // 1 hour TTL — discard if device unreachable
      )
    )
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const code = result.reason?.statusCode;
      if (code === 404 || code === 410) {
        // Subscription is gone — clean up
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
          .run(subs[i].endpoint);
        log.info('Pruned expired push subscription', { endpoint: subs[i].endpoint.slice(0, 40) });
      } else {
        log.warn('Push delivery failed', { code, err: result.reason?.message });
      }
    }
  });
}

module.exports = { sendPush, configured };
