'use strict';
/**
 * Client IP key for rate limiting.
 *
 * Render terminates traffic behind Cloudflare (responses carry server:
 * cloudflare / cf-ray). Without 'trust proxy', req.ip is the proxy address, so
 * keying on it would put every user in ONE bucket. X-Forwarded-For's leftmost
 * entry is client-controlled. Cloudflare sets CF-Connecting-IP itself, so it is
 * the trustworthy client address here.
 *
 * Production (or TRUST_CF_CONNECTING_IP=true): use CF-Connecting-IP when it is
 * a valid IP, else return null — callers then SKIP per-IP limits rather than
 * collapsing all users into a shared key. Elsewhere (dev/tests): socket address.
 * IPv6 addresses are reduced to their /64 (one host usually controls a /64).
 */

const net = require('net');

function normalize(ip) {
  if (typeof ip !== 'string') return null;
  let v = ip.trim();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7);
  if (net.isIPv4(v)) return v;
  if (!net.isIPv6(v)) return null;
  // Expand '::' and keep the first four hextets.
  const [head, tail = ''] = v.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).map(x => x || '0').join(':')}::/64`;
}

function trustCf() {
  if (process.env.TRUST_CF_CONNECTING_IP === 'false') return false;
  return process.env.TRUST_CF_CONNECTING_IP === 'true' || process.env.NODE_ENV === 'production';
}

/** @returns {string|null} a normalized client IP key, or null if it cannot be trusted. */
function clientIpKey(req) {
  if (trustCf()) {
    const cf = req.headers['cf-connecting-ip'];
    return normalize(Array.isArray(cf) ? cf[0] : cf);
  }
  return normalize(req.socket?.remoteAddress);
}

/** Wider key for a second limiter tier: an IPv6 /64 key → its /48; IPv4 → null. */
function wideIpKey(ipKey) {
  if (typeof ipKey !== 'string' || !ipKey.endsWith('::/64')) return null;
  return `${ipKey.slice(0, -5).split(':').slice(0, 3).join(':')}::/48`;
}

module.exports = { clientIpKey, wideIpKey, normalizeIp: normalize };
