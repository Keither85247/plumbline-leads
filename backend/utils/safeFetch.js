'use strict';
/**
 * Host-pinned HTTPS GET for fetching third-party media with credentials.
 *
 *  • Only `https:`, the default port, no userinfo, and a hostname approved by
 *    the caller's allow-list predicate. URLs are parsed with the WHATWG parser,
 *    so case, percent-encoding, backslashes, trailing dots and IPv6/decimal IP
 *    spellings are normalised before the check; IP-literal hosts are refused.
 *  • The hostname is resolved once and EVERY resolved address must be a public
 *    unicast address (no loopback, private, link-local, CGNAT, multicast,
 *    documentation, reserved, IPv4-mapped/NAT64/6to4 forms). The connection is
 *    then pinned to the vetted address, so DNS rebinding cannot swap targets.
 *  • Redirects are followed only if the caller allows them, at most
 *    `redirect.max` times, only to URLs approved by `redirect.isAllowed`, and
 *    NEVER with Authorization / Cookie headers (credentials go to the first,
 *    allow-listed host only).
 *  • No connection reuse (agent: false), so every request is pinned afresh.
 *  • DNS timeout, idle timeout and a hard deadline until response headers;
 *    redirect bodies are discarded unread. Errors carry fixed codes only —
 *    never a URL, header or response body — so callers can log them safely.
 */

const https = require('https');
const dns   = require('dns');
const net   = require('net');

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const BLOCKED_V6 = [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
];
// IPv6 must be global unicast (2000::/3) to begin with — this excludes ::/96
// (IPv4-compatible), ::ffff:0:0/96 and ::ffff:0:0:0/96 (mapped / translated),
// 64:ff9b::/96 (NAT64), 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8 and
// every other special-purpose prefix outside 2000::/3.
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
// Separate lists per family: Node's BlockList checks IPv4 addresses against
// IPv4-mapped IPv6 rules too, so ::ffff:0:0/96 in a shared list would match
// every IPv4 address.
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();
for (const [a, p] of BLOCKED_V4) blockedV4.addSubnet(a, p, 'ipv4');
for (const [a, p] of BLOCKED_V6) blockedV6.addSubnet(a, p, 'ipv6');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

const fail = (code) => Object.assign(new Error(code), { code, safeFetch: true });

/** True only for a public unicast address of the stated family. */
function isPublicAddress(address, family) {
  if ((family === 4 || family === 'IPv4') && net.isIPv4(address)) return !blockedV4.check(address, 'ipv4');
  if ((family === 6 || family === 'IPv6') && net.isIPv6(address)) {
    return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  }
  return false;
}

/** Parse and vet a URL; returns the WHATWG URL or throws a fixed-code error. */
function parseAllowed(raw, isAllowed) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) throw fail('bad_url');
  let u;
  try { u = new URL(raw); } catch { throw fail('bad_url'); }
  if (u.protocol !== 'https:')            throw fail('scheme');
  if (u.username || u.password)           throw fail('userinfo');
  if (u.port !== '' && u.port !== '443')  throw fail('port');
  const host = u.hostname;
  if (!host || net.isIP(host) || host.startsWith('[')) throw fail('ip_literal');
  if (typeof isAllowed !== 'function' || !isAllowed(u)) throw fail('host');
  return u;
}

/** Resolve once; EVERY address must be public. Returns all of them (for pinning). */
async function vettedAddresses(hostname, timeoutMs) {
  let addrs;
  let timer;
  try {
    addrs = await Promise.race([
      dns.promises.lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(fail('dns')), timeoutMs); }),
    ]);
  } catch { throw fail('dns'); }
  finally { clearTimeout(timer); }
  if (!Array.isArray(addrs) || !addrs.length) throw fail('dns');
  if (!addrs.every(a => isPublicAddress(a.address, a.family))) throw fail('unsafe_address');
  return addrs.map(a => ({ address: a.address, family: a.family === 'IPv6' ? 6 : a.family === 'IPv4' ? 4 : a.family }));
}

function requestOnce(u, headers, timeoutMs, pinned) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hard;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(hard); fn(v); } };
    let req;
    try {
      req = https.request({
        protocol: 'https:',
        hostname: u.hostname,
        servername: u.hostname,
        port: 443,
        method: 'GET',
        path: `${u.pathname}${u.search}`,
        headers,
        // A fresh socket every time: a pooled keep-alive socket would bypass
        // the pin below.
        agent: false,
        // Pin the socket to the vetted addresses (handles the `all` form used
        // by Node's happy-eyeballs connect as well as the classic form).
        lookup: (_host, opts, cb) => {
          if (opts && opts.all) cb(null, pinned.map(a => ({ address: a.address, family: a.family })));
          else cb(null, pinned[0].address, pinned[0].family);
        },
        timeout: timeoutMs,
      }, (res) => done(resolve, res));
    } catch {
      return done(reject, fail('network'));
    }
    // Idle timeout, plus a hard deadline until the response headers arrive
    // (a slow-drip server cannot hold the request open indefinitely).
    hard = setTimeout(() => { req.destroy(); done(reject, fail('timeout')); }, timeoutMs);
    req.on('timeout', () => { req.destroy(); done(reject, fail('timeout')); });
    req.on('error', () => done(reject, fail('network')));
    req.end();
  });
}

/**
 * @param {string} rawUrl
 * @param {{ headers?: object, isAllowed: (u: URL) => boolean,
 *           redirect?: { max: number, isAllowed: (u: URL) => boolean },
 *           timeoutMs?: number }} opts
 * @returns {Promise<import('http').IncomingMessage>} the final (non-redirect) response
 */
async function safeGet(rawUrl, opts = {}) {
  let url = parseAllowed(rawUrl, opts.isAllowed);
  let headers = { ...(opts.headers || {}) };
  const timeoutMs = opts.timeoutMs || 15_000;
  const maxRedirects = opts.redirect?.max || 0;
  for (let hop = 0; ; hop++) {
    const pinned = await vettedAddresses(url.hostname, timeoutMs);
    const res = await requestOnce(url, headers, timeoutMs, pinned);
    if (!REDIRECT_CODES.has(res.statusCode)) return res;
    res.destroy();                       // redirect bodies are never read
    if (hop >= maxRedirects) throw fail('redirect');
    const location = res.headers.location;
    if (typeof location !== 'string' || !location) throw fail('redirect');
    let next;
    try { next = new URL(location, url); } catch { throw fail('redirect'); }
    url = parseAllowed(next.href, opts.redirect.isAllowed);
    // Credentials are only ever sent to the first, allow-listed host.
    for (const k of Object.keys(headers)) {
      if (CREDENTIAL_HEADERS.includes(k.toLowerCase())) delete headers[k];
    }
  }
}

module.exports = { safeGet, parseAllowed, isPublicAddress };
