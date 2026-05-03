'use strict';
/**
 * Push notification delivery service — handles both Web Push (browser) and
 * FCM (Android Capacitor app).
 *
 * Web Push:  Requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL.
 * FCM:       Requires FIREBASE_SERVICE_ACCOUNT_JSON (see ANDROID_RELEASE.md).
 *
 * Both channels are tried simultaneously when sending. Either can be absent.
 */

const webpush = require('web-push');
const db      = require('../db');
const log     = require('../logger').for('Push');

// ── Web Push (VAPID) ─────────────────────────────────────────────────────────

const vapidConfigured = !!(
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY
);

if (vapidConfigured) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@plumblineleads.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  log.info('VAPID configured — Web Push enabled');
} else {
  log.warn('VAPID keys not set — Web Push disabled');
}

// ── FCM (Firebase Admin SDK) ─────────────────────────────────────────────────

let firebaseAdmin = null;
let fcmConfigured = false;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const admin = require('firebase-admin');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    firebaseAdmin = admin;
    fcmConfigured = true;
    log.info('Firebase Admin configured — FCM push enabled');
  } catch (err) {
    log.error('Firebase Admin init failed:', err.message);
  }
} else {
  log.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM (Android) push disabled');
}

// ── sendPush ─────────────────────────────────────────────────────────────────

/**
 * Send a push notification to all subscriptions for the given userId.
 * Pass userId = null to broadcast to all subscriptions.
 *
 * Sends to Web Push subscriptions AND FCM tokens simultaneously.
 *
 * @param {number|null} userId
 * @param {{ title: string, body: string, tag?: string, url?: string }} payload
 */
async function sendPush(userId, payload) {
  await Promise.all([
    sendWebPush(userId, payload),
    sendFcm(userId, payload),
  ]);
}

async function sendWebPush(userId, payload) {
  if (!vapidConfigured) return;

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
        { TTL: 60 * 60 }
      )
    )
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const code = result.reason?.statusCode;
      if (code === 404 || code === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
          .run(subs[i].endpoint);
        log.info('Pruned expired Web Push subscription');
      } else {
        log.warn('Web Push delivery failed', { code, err: result.reason?.message });
      }
    }
  });
}

async function sendFcm(userId, payload) {
  if (!fcmConfigured) return;

  const tokens = userId == null
    ? db.prepare('SELECT fcm_token FROM fcm_subscriptions').all().map(r => r.fcm_token)
    : db.prepare(
        'SELECT fcm_token FROM fcm_subscriptions WHERE user_id = ? OR user_id IS NULL'
      ).all(userId).map(r => r.fcm_token);

  if (tokens.length === 0) return;

  const message = {
    notification: {
      title: payload.title,
      body:  payload.body,
    },
    data: {
      url: payload.url || '/',
      tag: payload.tag || 'plumbline',
    },
    android: {
      priority: 'high',
      notification: {
        sound:       'default',
        channelId:   'calls',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
    tokens,
  };

  try {
    const response = await firebaseAdmin.messaging().sendEachForMulticast(message);
    response.responses.forEach((res, i) => {
      if (!res.success) {
        const errCode = res.error?.code;
        if (
          errCode === 'messaging/registration-token-not-registered' ||
          errCode === 'messaging/invalid-registration-token'
        ) {
          db.prepare('DELETE FROM fcm_subscriptions WHERE fcm_token = ?').run(tokens[i]);
          log.info('Pruned expired FCM token');
        } else {
          log.warn('FCM delivery failed', { errCode });
        }
      }
    });
    log.info(`FCM sent to ${response.successCount}/${tokens.length} devices`);
  } catch (err) {
    log.error('FCM send error', { err: err.message });
  }
}

module.exports = { sendPush, configured: vapidConfigured || fcmConfigured };
