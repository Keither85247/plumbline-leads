'use strict';
/**
 * Hermetic tests — frontend sign-in lifecycle, Twilio Voice teardown and logout.
 *
 * Bundles the REAL frontend/src/App.jsx (with useAuthSession, useVoiceDevice
 * and api.js) using esbuild, stubbing only leaf components, Sentry, Capacitor
 * and the Twilio SDK. App is rendered by a tiny single-root hook runtime (no
 * DOM), against a fake backend and a fake Twilio Device that behaves like SDK
 * 2.18 (destroy() emits 'unregistered' synchronously, then removes listeners).
 * No network, no real calls.
 *
 *   A. Cold start: signed in → exactly one Device, correctly identified.
 *   B. Explicit logout: teardown first, listeners removed, local auth cleared.
 *   C. Login after cleanup → one new Device for the new account (account switch).
 *   D. Failed logout (network / 5xx / timeout): honest notice, local auth and
 *      voice cleared, pending sign-out retried — never resumed from the cookie.
 *   E. Forced sign-out (poll 401 + /auth/me 401), transient errors ignored,
 *      suspended/blocked accounts, voice-token 401.
 *   F. Failed cold-start authentication (expired, disabled, unreachable).
 *   G. Races, idempotent teardown, stale events, alerts, other-tab changes.
 *   H. makeCall(): logout / forced sign-out / Voice-token 401 / account change
 *      / other tab / Device replacement / unmount while connect() is pending;
 *      late resolve, reject and call events; the normal path still connects.
 *
 * Run: node scripts/test-frontend-auth.js
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const FE   = path.join(ROOT, 'frontend');
const SRC  = path.join(FE, 'src');
const esbuild = require(path.join(FE, 'node_modules/esbuild'));

const origStdout = process.stdout.write.bind(process.stdout);
const say = (s) => origStdout(s + '\n');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); say(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const logged = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug', 'group', 'groupEnd']) {
  const orig = console[m]?.bind(console);
  console[m] = (...a) => { logged.push(a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); if (process.env.VERBOSE && orig) orig(...a); };
}

// ── Mini React runtime (one root component, hooks in call order) ───────────
const R = {
  Fragment: Symbol('Fragment'),
  root: null, hooks: [], idx: 0, effects: [], scheduled: false, tree: null, renders: 0,
  hookCount: null, hookCountErrors: 0, errors: [],
};
R.createElement = (type, props, ...children) => {
  const p = { ...(props || {}) };
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return { type, props: p };
};
R.useState = (init) => {
  const i = R.idx++;
  if (!R.hooks[i]) {
    const h = { v: typeof init === 'function' ? init() : init };
    h.set = (nv) => { const v = typeof nv === 'function' ? nv(h.v) : nv; if (Object.is(v, h.v)) return; h.v = v; schedule(); };
    R.hooks[i] = h;
  }
  return [R.hooks[i].v, R.hooks[i].set];
};
R.useRef = (init) => { const i = R.idx++; if (!R.hooks[i]) R.hooks[i] = { current: init }; return R.hooks[i]; };
const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]));
R.useMemo = (fn, deps) => { const i = R.idx++; const h = R.hooks[i]; if (!h || depsChanged(deps, h.deps)) R.hooks[i] = { v: fn(), deps }; return R.hooks[i].v; };
R.useCallback = (fn, deps) => R.useMemo(() => fn, deps);
R.useEffect = (fn, deps) => {
  const i = R.idx++;
  const h = R.hooks[i];
  if (!h) R.hooks[i] = { deps: undefined, cleanup: null, fresh: true };
  if (!h || h.fresh || depsChanged(deps, h.deps)) R.effects.push({ i, fn, deps });
};
R.useLayoutEffect = R.useEffect;
R.useContext = (ctx) => (ctx ? ctx._v : undefined);
R.createContext = (v) => ({ _v: v, Provider: (p) => p.children });
function render() {
  if (!R.root) return;
  R.idx = 0;
  R.effects = [];
  R.tree = R.root.fn(R.root.props || {});
  R.renders++;
  if (R.hookCount !== null && R.hookCount !== R.idx) R.hookCountErrors++;
  R.hookCount = R.idx;
  const eff = R.effects;
  R.effects = [];
  for (const e of eff) {
    const h = R.hooks[e.i];
    if (h?.cleanup) { try { h.cleanup(); } catch (err) { R.errors.push(err); } }
    let c;
    try { c = e.fn(); } catch (err) { R.errors.push(err); }
    R.hooks[e.i] = { deps: e.deps, cleanup: typeof c === 'function' ? c : null };
  }
}
function schedule() {
  if (R.scheduled) return;
  R.scheduled = true;
  queueMicrotask(() => { R.scheduled = false; render(); });
}
function mount(fn) { R.root = { fn }; R.hooks = []; R.hookCount = null; render(); }
function unmount() {
  for (const h of R.hooks) if (h && h.cleanup) { try { h.cleanup(); } catch (err) { R.errors.push(err); } }
  R.root = null; R.hooks = []; R.tree = null;
}
globalThis.__R = R;

// ── Fake browser ───────────────────────────────────────────────────────────
const events = [];                         // ordered trace: 'destroy:user_1', 'fetch:POST /auth/logout', …
function trackedTarget(name) {
  const t = new EventTarget();
  t.counts = {};
  const add = t.addEventListener.bind(t), rem = t.removeEventListener.bind(t);
  const live = new Map();                  // type → Set(fn|capture)
  t.addEventListener = (type, fn, opts) => {
    const k = `${(typeof opts === 'object' ? opts?.capture : opts) ? 1 : 0}`;
    const set = live.get(type) || new Set(); live.set(type, set);
    if (!set.has(fn + '|' + k) || !set.has(fn)) { set.add(fn); }
    add(type, fn, opts);
    t.counts[type] = (live.get(type) || new Set()).size;
  };
  t.removeEventListener = (type, fn, opts) => {
    live.get(type)?.delete(fn);
    rem(type, fn, opts);
    t.counts[type] = (live.get(type) || new Set()).size;
  };
  t.listenerCount = (type) => live.get(type)?.size || 0;
  t.label = name;
  return t;
}
const win = trackedTarget('window');
const doc = trackedTarget('document');
let reloads = 0;
Object.assign(win, {
  location: { hostname: 'app.example.test', origin: 'https://app.example.test', pathname: '/', search: '', href: 'https://app.example.test/', reload: () => { reloads++; events.push('reload'); } },
  Capacitor: undefined,
});
Object.assign(doc, { title: 'PlumbLine Leads', visibilityState: 'visible' });
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
class FakeAudio { constructor(src) { this.src = src; this.loop = false; this.currentTime = 0; this.paused = true; } load() {} play() { this.paused = false; events.push('ringtone:play'); return Promise.resolve(); } pause() { this.paused = true; } }
Object.assign(globalThis, { window: win, document: doc, localStorage, Audio: FakeAudio });
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-test', onLine: true }, configurable: true, writable: true });
win.localStorage = localStorage;
win.addEventListener = win.addEventListener.bind(win);

// ── Fake Twilio Device (SDK 2.18 semantics) ────────────────────────────────
const Fake = { devices: [], registrations: [], destroyCalls: 0, updateTokens: 0, calls: [], REJECT_UNDEFINED: Symbol('reject without a reason'), REJECT_NULL: Symbol('reject with null') };
class FakeCall {
  constructor(parameters) { this.parameters = parameters; this.customParameters = new Map(); this.listeners = {}; this.disconnects = 0; this.onAttach = null; this._status = 'pending'; }
  status() { return this._status; }
  // onAttach (set by a test) runs once, inside the first handler registration.
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); const hook = this.onAttach; this.onAttach = null; hook?.(evt); return this; }
  emit(evt, ...a) { for (const fn of [...(this.listeners[evt] || [])]) fn(...a); }
  listenerTotal() { return Object.values(this.listeners).reduce((n, l) => n + l.length, 0); }
  accept() {} reject() { events.push('call:reject'); }
  // Like the SDK: hanging up an open call emits 'disconnect'; on a closed one it does nothing.
  disconnect() { this.disconnects++; events.push('call:disconnect'); if (this._status === 'closed') return; this._status = 'closed'; this.emit('disconnect', this); }
  // Signalling dropped before the call was answered: the SDK emits
  // 'transportClose', marks the call closed and emits nothing else.
  dropTransport() { this.emit('transportClose'); this._status = 'closed'; }
}
class FakeDevice {
  constructor(token) {
    this.token = token;
    this.identity = String(token).split('.')[1];
    this.state = 'unregistered';
    this.listeners = {};
    this.destroyed = false;
    this.handed = [];                     // calls connect() returned
    Fake.devices.push(this);
    events.push(`device:new:${this.identity}`);
  }
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return this; }
  emit(evt, ...a) { for (const fn of [...(this.listeners[evt] || [])]) fn(...a); }
  register() {
    if (this.destroyed) return Promise.reject(new Error('destroyed'));
    this.state = 'registered';
    Fake.registrations.push(this.identity);
    queueMicrotask(() => { if (!this.destroyed) this.emit('registered'); });
    return Promise.resolve();
  }
  updateToken(t) { if (this.destroyed) throw new Error('destroyed'); Fake.updateTokens++; this.token = t; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    Fake.destroyCalls++;
    events.push(`device:destroy:${this.identity}`);
    for (const call of this.handed) if (call.status() !== 'closed') call.disconnect();   // like disconnectAll()
    this.state = 'destroyed';
    this.emit('unregistered');            // synchronously, like the SDK
    this.emit('destroyed');
    this.listeners = {};
  }
  // A fake outbound call object — never a real call.
  async connect({ params } = {}) {
    events.push(`device:connect:${this.identity}`);          // any attempt counts — even on a destroyed Device
    if (this.destroyed) throw new Error('destroyed');
    // Fake.connectGate (set by a test) keeps connect() pending. It settles with
    // what the gate resolves to — an Error rejects, anything else hands back a
    // call, even if this Device was destroyed meanwhile.
    if (Fake.connectGate) {
      const outcome = await Fake.connectGate;
      if (outcome instanceof Error) throw outcome;
      if (outcome === Fake.REJECT_UNDEFINED) throw undefined;   // like the SDK when signalling closes meanwhile
      if (outcome === Fake.REJECT_NULL) throw null;
    }
    const call = new FakeCall({ CallSid: 'CA' + 'f'.repeat(32), To: params?.To });
    Fake.onCall?.(call);
    Fake.calls.push(call);
    this.handed.push(call);
    return call;
  }
}
globalThis.__FakeDevice = FakeDevice;
const live = () => Fake.devices.filter(d => !d.destroyed && d.state === 'registered').map(d => d.identity);

// ── Fake backend ───────────────────────────────────────────────────────────
// Models what matters here: sessions by token, an optional cookie jar
// (S.cookies = true ≈ Chrome/Android, where the httpOnly cookie is sent; false
// ≈ Safari ITP, Bearer only), /auth/logout reporting { presented, ended },
// gates to hold responses in flight, and per-account data.
const S = {
  users: { 1: { id: 1, email: 'owner@example.test', display_name: 'Owner', business_name: 'Owner Biz', is_owner: 1, access_status: 'owner', assignedNumber: null },
           2: { id: 2, email: 'second@example.test', display_name: 'Second', is_owner: 1, access_status: 'owner', assignedNumber: null },
           3: { id: 3, email: 'paywalled@example.test', display_name: 'Pay', is_owner: 0, access_status: 'unknown', assignedNumber: { id: 9, phone_number: '+15550000099' } },
           4: { id: 4, email: 'nonumber@example.test', display_name: 'NoNum', is_owner: 0, access_status: 'tester', assignedNumber: null } },
  sessions: new Map(),                    // raw token → user id
  cookies: false, jar: null,
  disabled: new Set(),
  logoutMode: 'ok', meMode: 'normal', meGate: null, tokenGate: null, tokenIdentityOverride: null, tokenCode: null,
  countsMode: 'normal', leadsMode: 'normal', leads: { 1: [{ id: 101, contact_name: 'Alice Customer of account 1', status: 'New', created_at: '2026-10-01T00:00:00Z' }], 2: [] },
  ticketGate: null, healthGate: null, loginGate: null, leadsGate: null, logoutGate: null,
  tokenRequests: 0, logoutRequests: 0, meRequests: 0, n: 0,
};
const newTok = () => 'pl1_' + require('crypto').randomBytes(32).toString('base64url');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Map([['content-type', 'application/json']]),
  json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } });
function bearer(opts) { const a = opts?.headers?.Authorization || opts?.headers?.authorization; return a ? a.slice(7) : null; }
const cookieOf = (opts) => (S.cookies && opts?.credentials !== 'omit' ? S.jar : null);
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://backend.test');
  const method = (opts.method || 'GET').toUpperCase();
  const p = u.pathname;
  events.push(`fetch:${method} ${p}`);
  const b = bearer(opts), c = cookieOf(opts);
  let uid = S.sessions.get(b) ?? S.sessions.get(c);
  const unauth = (code) => json(401, code ? { error: 'Account not active', code } : { error: 'Session expired. Please log in again.' });
  // Like requireAuth: the FIRST request of a suspended account gets the reason
  // and revokes every session of it; later requests get a plain 401.
  if (uid && S.disabled.has(uid) && !p.startsWith('/auth/log')) {
    for (const [t, id] of [...S.sessions]) if (id === uid) S.sessions.delete(t);
    return unauth('ACCOUNT_DISABLED');
  }
  if (p === '/auth/login' && method === 'POST') {
    if (S.loginGate) await S.loginGate;
    const { email } = JSON.parse(opts.body || '{}');
    const user = Object.values(S.users).find(x => x.email === email);
    if (!user) return json(401, { error: 'Invalid email or password' });
    const token = newTok();
    S.sessions.set(token, user.id);
    if (S.cookies) S.jar = token;
    return json(200, { ...user, token });
  }
  if (p === '/auth/me') {
    S.meRequests++;
    if (S.meGate) await S.meGate;
    if (S.meMode === 'network') throw new TypeError('Failed to fetch');
    if (S.meMode === '503') return json(503, { error: 'unavailable' });
    if (!uid) return unauth(S.meCode || null);
    return json(200, S.users[uid]);
  }
  if (p === '/auth/logout' && method === 'POST') {
    S.logoutRequests++;
    if (S.logoutGate) await S.logoutGate;
    if (S.logoutMode === 'network') throw new TypeError('Failed to fetch');
    if (S.logoutMode === '503') return json(503, { error: 'unavailable' });
    if (S.logoutMode === 'hang') {
      return new Promise((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    let bodyTok = null;
    if (/text\/plain/.test(opts.headers?.['Content-Type'] || '')) { try { bodyTok = JSON.parse(opts.body || '{}').token || null; } catch {} }
    const creds = [...new Set([b, c, bodyTok].filter(Boolean))];
    let ended = 0;
    for (const t of creds) if (S.sessions.delete(t)) ended++;
    if (c) S.jar = null;
    events.push(`logout:presented=${creds.length}:ended=${ended}${opts.credentials === 'omit' ? ':omit' : ''}`);
    if (S.logoutMode === 'legacy') return json(200, { ok: true });      // an older server: no counts
    return json(200, { ok: true, presented: creds.length, ended });
  }
  if (p === '/api/twilio/token') {
    S.tokenRequests++;
    if (S.tokenGate) await S.tokenGate;
    if (S.tokenCode) return unauth(S.tokenCode);
    if (S.tokenMode === '500') return json(500, { error: 'Failed to fetch voice token' });
    if (!uid) return unauth();
    const identity = S.tokenIdentityOverride || `user_${uid}`;
    return json(200, { token: `jwt.${identity}.${++S.n}`, identity });
  }
  if (p === '/api/counts') {
    if (S.countsMode === 'disabled') return unauth('ACCOUNT_DISABLED');
    if (!uid) return unauth();
    return json(200, { calls: 0, texts: 0, emails: 0 });
  }
  if (p === '/api/media/tickets') {
    if (S.ticketGate) await S.ticketGate;
    if (!uid) return unauth();
    const { items } = JSON.parse(opts.body || '{}');
    return json(200, { tickets: (items || []).map(() => require('crypto').randomBytes(32).toString('base64url').slice(0, 43)) });
  }
  if (p.startsWith('/api/leads')) {
    if (S.leadsGate) { const g = S.leadsGate; await g; }
    if (!uid) return unauth();
    if (S.leadsMode === '503') return json(503, { error: 'unavailable' });
    return json(200, S.leads[uid] || []);
  }
  if (p === '/api/health' || p === '/health') { if (S.healthGate) await S.healthGate; return json(200, { ok: true }); }
  if (p === '/api/calls/ensure-logged') { events.push('ensure-logged'); return uid ? json(200, { ok: true }) : unauth(); }
  if (p === '/api/push/fcm-subscribe') { events.push(`fcm-subscribe:${uid ?? 'anon'}`); return uid ? json(200, { ok: true }) : unauth(); }
  return uid ? json(200, {}) : unauth();
};

// Fake Capacitor / FCM plugin (used by the real useCapacitorPush test).
const FakePush = { listeners: {}, registered: 0 };
globalThis.__FakePush = {
  requestPermissions: async () => ({ receive: 'granted' }),
  register: async () => { FakePush.registered++; },
  addListener: (evt, fn) => { (FakePush.listeners[evt] ||= []).push(fn); return { remove() {} }; },
};
globalThis.__capacitorNative = false;
const navigatorBase = { userAgent: 'node-test', onLine: true };

// ── Bundle the real App ────────────────────────────────────────────────────
const OUT = path.join(os.tmpdir(), `plumbline-fe-auth-${process.pid}.cjs`);
const STUB_COMPONENT = /^\.\/components\//;
const STUB_MODULES = new Set(['./refreshBus', './hooks/usePushNotifications', './hooks/useCapacitorPush']);
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime)?$/ }, a => ({ path: a.path, namespace: 'react-shim' }));
    b.onLoad({ filter: /.*/, namespace: 'react-shim' }, () => ({ loader: 'js', contents: `
      const R = globalThis.__R;
      export const useState = (...a) => R.useState(...a), useEffect = (...a) => R.useEffect(...a), useRef = (...a) => R.useRef(...a),
        useCallback = (...a) => R.useCallback(...a), useMemo = (...a) => R.useMemo(...a), useContext = (...a) => R.useContext(...a),
        useLayoutEffect = (...a) => R.useLayoutEffect(...a), createContext = (...a) => R.createContext(...a),
        createElement = (...a) => R.createElement(...a), Fragment = R.Fragment, memo = (c) => c, forwardRef = (f) => f, StrictMode = (p) => p.children;
      export const jsx = (t, p) => R.createElement(t, p), jsxs = jsx, jsxDEV = jsx;
      export default { useState, useEffect, useRef, useCallback, useMemo, useContext, useLayoutEffect, createContext, createElement, Fragment, memo, forwardRef, StrictMode };` }));
    b.onResolve({ filter: /^@twilio\/voice-sdk$/ }, () => ({ path: 'voice', namespace: 'stub' }));
    b.onResolve({ filter: /^@sentry\/react$/ }, () => ({ path: 'sentry', namespace: 'stub' }));
    b.onResolve({ filter: /^@capacitor\// }, () => ({ path: 'capacitor', namespace: 'stub' }));
    b.onResolve({ filter: /^\.\// }, a => {
      if (!a.importer.endsWith(`${path.sep}App.jsx`)) return undefined;
      if (STUB_COMPONENT.test(a.path)) return { path: a.path, namespace: 'component' };
      if (STUB_MODULES.has(a.path)) return { path: a.path, namespace: 'stub' };
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'component' }, a => {
      const name = path.basename(a.path).replace(/\W/g, '_');
      return { loader: 'js', contents: `const C = function ${name}() { return null; }; export default C;` };
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, a => {
      const c = {
        voice: 'export const Device = globalThis.__FakeDevice; export default { Device };',
        sentry: `export const setUser = (u) => { (globalThis.__sentryUsers ||= []).push(u); };
                 export const captureException = () => {}; export const captureMessage = () => {};
                 export const ErrorBoundary = (p) => p.children; export const init = () => {};
                 export const browserTracingIntegration = () => ({}); export default {};`,
        capacitor: `export const Capacitor = { isNativePlatform: () => !!globalThis.__capacitorNative, getPlatform: () => (globalThis.__capacitorNative ? 'android' : 'web') };
                    export const PushNotifications = globalThis.__FakePush; export const App = {}; export default {};`,
        './refreshBus': 'export const useRefreshKey = (k) => (globalThis.__refresh?.[k] || 0); export const useInvalidate = () => () => {}; export const RefreshProvider = (p) => p.children;',
        './hooks/usePushNotifications': 'export function usePushNotifications() { return { supported: false, subscribed: false, permission: "denied", subscribe: async () => {} }; }',
        './hooks/useCapacitorPush': 'export function useCapacitorPush() {}',
      }[a.path];
      return { loader: 'js', contents: c ?? 'export default {};' };
    });
  },
};

async function main() {
  const common = {
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: true, logLevel: 'silent',
    jsx: 'automatic', loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.mp3': 'dataurl' },
    define: { 'import.meta.env': JSON.stringify({ VITE_BACKEND_URL: 'http://backend.test', DEV: false, PROD: true, MODE: 'test' }) },
    plugins: [stubPlugin],
  };
  await esbuild.build({ ...common, outfile: OUT,
    stdin: { contents: `export { default as App } from ${JSON.stringify(path.join(SRC, 'App.jsx'))};
                        export * as api from ${JSON.stringify(path.join(SRC, 'api.js'))};
                        export * as voiceHook from ${JSON.stringify(path.join(SRC, 'hooks/useVoiceDevice.js'))};`, resolveDir: SRC, loader: 'js' } });
  // Real LoginPage and real useCapacitorPush (not stubbed here).
  const OUT2 = OUT.replace(/\.cjs$/, '-units.cjs');
  await esbuild.build({ ...common, outfile: OUT2,
    stdin: { contents: `export { default as LoginPage } from ${JSON.stringify(path.join(SRC, 'components/LoginPage.jsx'))};
                        export { useCapacitorPush } from ${JSON.stringify(path.join(SRC, 'hooks/useCapacitorPush.js'))};
                        export { default as GmailConnectionView } from ${JSON.stringify(path.join(SRC, 'components/GmailConnectionView.jsx'))};`, resolveDir: SRC, loader: 'js' } });
  // A "page load" = a fresh copy of the bundle (fresh module memory).
  let loads = 0;
  const loadPage = () => { const f = OUT.replace(/\.cjs$/, `-p${++loads}.cjs`); fs.copyFileSync(OUT, f); return require(f); };
  let { App, api, voiceHook } = loadPage();

  // helpers
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function waitFor(cond, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(5); } return cond(); }
  async function settle(ms = 60) { await sleep(ms); }
  const walk = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach(n => walk(n, pred, out)); return out; }
    if (node.type !== undefined && pred(node)) out.push(node);
    if (node.props) walk(node.props.children, pred, out);
    return out;
  };
  const find = (pred, tree = R.tree) => walk(tree, pred)[0] || null;
  const byName = (name) => (n) => typeof n.type === 'function' && n.type.name === name;
  const loginPage = () => find(byName('LoginPage'));
  const logoutButton = () => find(n => n.props?.['aria-label'] === 'Log out');
  // The voice API object as App holds it (useAuthSession keeps it in a ref).
  const voiceProp = () => R.hooks.map(h => h && h.current).find(v => v && typeof v.teardown === 'function' && typeof v.initialize === 'function') || null;
  const signedIn = () => !!logoutButton();
  const listeners = () => ({ vis: doc.listenerCount('visibilitychange'), focus: win.listenerCount('focus'),
    touch: doc.listenerCount('touchstart'), click: doc.listenerCount('click') });
  const sinceMark = (mark) => events.slice(events.lastIndexOf(mark) + 1);
  const mark = (m) => { events.push(m); return m; };
  async function freshApp({ token = null, pending = false, keepStore = false, reload = false } = {}) {
    if (R.root) unmount();
    if (reload) ({ App, api } = loadPage());
    if (!keepStore) { store.clear(); store.set('plOnboardingSeen', '1'); }
    if (token) store.set('plumbline_token', token);
    if (pending) store.set('plumbline_logout_pending', '1');
    mount(App);
    await waitFor(() => !!(signedIn() || loginPage() || find(byName('PaywallGate')) || find(byName('NumberPickerModal'))), 6000);
    await settle();
  }
  async function signInAs(uid) {
    const user = await api.login(S.users[uid].email, 'pw');
    await loginPage().props.onSuccess(user);
    await waitFor(() => signedIn() && live().length > 0);
    await settle();
    return user;
  }
  const seed = (uid) => { const t = newTok(); S.sessions.set(t, uid); return t; };
  const clickLogout = async () => { await logoutButton().props.onClick(); await waitFor(() => !!loginPage()); await settle(); };

  try {
    // ── A. Cold start ────────────────────────────────────────────────────────
    let m = mark('A');
    await freshApp({ token: seed(1) });
    ok('A1 cold start with a valid session → signed in with exactly ONE Device, registered as client:user_1',
      signedIn() && Fake.devices.length === 1 && live().join() === 'user_1', JSON.stringify({ live: live(), n: Fake.devices.length }));
    let L = listeners();
    ok('A2 while signed in, the visibility/focus refresh listeners and the ringtone unlock listeners are attached once',
      L.vis === 1 && L.focus === 1 && L.touch === 1 && L.click === 1, JSON.stringify(L));
    ok('A3 the hook runtime saw a stable hook order (no conditional hooks in App)', R.hookCountErrors === 0 && R.errors.length === 0, String(R.errors[0] || ''));
    win.dispatchEvent(new Event('focus'));
    await settle(80);
    ok('A4 a soft token refresh of a registered Device returns the dialer to ready (not stuck on "Connecting")', voiceProp().status === 'ready', voiceProp().status);

    // ── B. Explicit logout ──────────────────────────────────────────────────
    m = mark('B');
    const tB = store.get('plumbline_token');
    await clickLogout();
    let ev = sinceMark(m);
    const iDestroy = ev.indexOf('device:destroy:user_1'), iLogout = ev.indexOf('fetch:POST /auth/logout');
    ok('B1 logout tears the Device down BEFORE the server request (no ring or registration while signing out)',
      iDestroy >= 0 && iLogout > iDestroy, ev.join(','));
    L = listeners();
    ok('B2 logout removes the visibility, focus and ringtone-unlock listeners', L.vis === 0 && L.focus === 0 && L.touch === 0 && L.click === 0, JSON.stringify(L));
    ok('B3 no Device remains registered and the destroy\'s synchronous \'unregistered\' started no recovery (no token fetch)',
      live().length === 0 && !ev.some(e => e === 'fetch:GET /api/twilio/token'));
    ok('B4 server sign-out confirmed → local token removed, no pending marker, login page without a notice',
      store.get('plumbline_token') === undefined && !store.has('plumbline_logout_pending') && loginPage()?.props.notice === null);
    ok('B5 the server session for that token is really gone (the logout presented it and ended it)',
      !S.sessions.has(tB) && ev.includes('logout:presented=1:ended=1'));

    // ── C. Login after cleanup / account switch ─────────────────────────────
    m = mark('C');
    const before = Fake.devices.length;
    await signInAs(2);
    ok('C1 signing in as another account creates exactly ONE new Device, identified as client:user_2, and nothing is registered as user_1',
      Fake.devices.length === before + 1 && live().join() === 'user_2' && Fake.devices.filter(d => d.identity === 'user_1').every(d => d.destroyed));
    ok('C2 the signed-in user object held by the app carries no session token', !JSON.stringify(R.hooks.map(h => h && h.v)).includes('pl1_'));
    await clickLogout();
    await signInAs(1);
    ok('C3 switching back and forth never leaves two Devices alive or a previous identity registered',
      live().join() === 'user_1' && Fake.devices.filter(d => !d.destroyed).length === 1);
    // Per-account data never carries over to the next account.
    await waitFor(() => (find(byName('LeadList'))?.props.leads || []).length === 1);
    const hadLead = (find(byName('LeadList'))?.props.leads || []).length === 1;
    await clickLogout();
    S.leadsMode = '503';
    await signInAs(2);
    await settle(80);
    S.leadsMode = 'normal';
    const leadsB = find(byName('LeadList'))?.props.leads;
    ok('C4 the next account never sees the previous account\'s leads, even when its own fetch fails',
      hadLead && Array.isArray(leadsB) && leadsB.length === 0, JSON.stringify(leadsB));
    await clickLogout();
    // A leads answer for the previous sign-in that arrives late is dropped.
    await freshApp({ token: seed(1) });
    let releaseLeads; S.leadsGate = new Promise(r => { releaseLeads = r; });
    globalThis.__refresh = { leads: (globalThis.__refresh?.leads || 0) + 1 }; schedule(); await settle(40);   // a refresh now hangs
    await clickLogout();
    S.leadsMode = '503';
    const gateA = S.leadsGate; S.leadsGate = null;
    await signInAs(2);
    await settle(40);                                     // account 2's own fetch has failed (503)
    S.leadsMode = 'normal';
    releaseLeads(); await gateA;                          // account 1's late answer (its leads) arrives now
    await settle(80);
    const leadsLate = find(byName('LeadList'))?.props.leads;
    ok('C5 a leads answer for the previous sign-in that arrives late never fills the next account\'s list',
      Array.isArray(leadsLate) && leadsLate.length === 0, JSON.stringify(leadsLate));
    await clickLogout();
    // Contractor / business names are per account; old device-wide values are moved only to the account they belong to.
    store.clear(); store.set('plOnboardingSeen', '1');
    store.set('contractorName', 'Someone Else'); store.set('businessName', 'Their Biz');
    await freshApp({ token: seed(1), keepStore: true });
    const namesProps = find(n => n.props && 'contractorName' in n.props && 'businessName' in n.props)?.props
      || find(n => n.props && 'contractorName' in n.props)?.props || {};
    ok('N1 another account\'s device-wide names are not taken over (kept for their owner); this account uses its own profile',
      namesProps.contractorName === 'Owner' && store.get('contractorName') === 'Someone Else' && store.get('businessName') === 'Their Biz'
      && store.get('businessName:1') === 'Owner Biz', JSON.stringify({ c: namesProps.contractorName }));
    await clickLogout();
    store.clear(); store.set('plOnboardingSeen', '1');
    store.set('contractorName', 'Owner'); store.set('businessName', 'Kept Biz');
    await freshApp({ token: seed(1), keepStore: true });
    ok('N2 this account\'s own device-wide names are moved to its per-account keys (business name preserved)',
      store.get('contractorName:1') === 'Owner' && store.get('businessName:1') === 'Kept Biz' && !store.has('contractorName') && !store.has('businessName'));
    await clickLogout();

    // ── D. Failed logout ────────────────────────────────────────────────────
    // Safari-like client (Bearer only): the stored token is the ONLY credential.
    S.cookies = false;
    await freshApp({ token: seed(1) });
    const tD = store.get('plumbline_token');
    S.logoutMode = 'network';
    m = mark('D');
    await clickLogout();
    ok('D1 a failed server sign-out still destroys the Device and clears the stored token',
      live().length === 0 && store.get('plumbline_token') === undefined);
    ok('D2 …and does NOT pretend success: a pending sign-out is recorded and the login page says it could not be confirmed',
      store.get('plumbline_logout_pending') === '1' && loginPage()?.props.notice?.kind === 'logout_unconfirmed');
    ok('D3 the notice carries no technical detail (no token, endpoint or error text)',
      !JSON.stringify(loginPage().props.notice).match(/pl1_|\/auth|Failed to fetch|TypeError/));
    let retried = await loginPage().props.onRetryLogout();
    await settle();
    ok('D4 retrying while still offline keeps the notice (still unconfirmed)', retried === false && loginPage()?.props.notice?.kind === 'logout_unconfirmed');
    S.logoutMode = 'ok';
    m = mark('D5');
    retried = await loginPage().props.onRetryLogout();
    await settle();
    ev = sinceMark(m);
    ok('D5 "Try again" on the same page presents the old session\'s credential (kept in memory only) and really ends it on the server',
      retried === true && !S.sessions.has(tD) && ev.includes('logout:presented=1:ended=1') && loginPage()?.props.notice === null
      && !store.has('plumbline_logout_pending') && ![...store.values()].includes(tD));
    // Failed logout, then the page is reloaded (memory gone), Safari-like: nothing can be presented.
    await freshApp({ token: seed(1) });
    const tD6 = store.get('plumbline_token');
    S.logoutMode = 'network';
    await clickLogout();
    S.logoutMode = 'ok';
    m = mark('D6');
    await freshApp({ keepStore: true, reload: true });
    ev = sinceMark(m);
    ok('D6 after a reload, a Bearer-only client cannot present the old credential: the retry is reported honestly as unverifiable (never "confirmed"), no retry loop, no Device',
      !signedIn() && loginPage()?.props.notice?.kind === 'logout_unverifiable' && ev.includes('logout:presented=0:ended=0')
      && !ev.includes('fetch:GET /auth/me') && !ev.some(e => e.startsWith('device:new')) && !store.has('plumbline_logout_pending')
      && S.sessions.has(tD6), ev.join(','));
    S.sessions.delete(tD6);
    // Same, Chrome/Android-like: the cookie still carries the old session.
    S.cookies = true;
    await freshApp();
    await signInAs(1);
    const tD7 = S.jar;
    S.logoutMode = 'network';
    await clickLogout();
    S.logoutMode = 'ok';
    m = mark('D7');
    await freshApp({ keepStore: true, reload: true });
    ev = sinceMark(m);
    ok('D7 after a reload, a cookie client retries with the cookie: the old session is ended and nothing is resumed (no /auth/me, no Device)',
      !signedIn() && !S.sessions.has(tD7) && ev.includes('logout:presented=1:ended=1') && !ev.includes('fetch:GET /auth/me')
      && !ev.some(e => e.startsWith('device:new')) && loginPage()?.props.notice === null && !store.has('plumbline_logout_pending'), ev.join(','));
    S.cookies = false;
    S.logoutMode = '503';
    await freshApp({ pending: true });
    ok('D8 if the server still cannot be reached, the user is told again (still signed out)', !signedIn() && loginPage()?.props.notice?.kind === 'logout_unconfirmed');
    S.logoutMode = 'ok';
    // API outcomes.
    store.set('plumbline_token', seed(1));
    S.logoutMode = '503';
    let out = await api.logout();
    ok('D9 a 5xx is not a confirmed sign-out', out.serverConfirmed === false && store.get('plumbline_logout_pending') === '1' && !store.has('plumbline_token'));
    S.logoutMode = 'hang';
    store.set('plumbline_token', seed(1));
    const t0 = Date.now();
    out = await Promise.race([api.logout(), sleep(15000).then(() => ({ hung: true }))]);
    ok('D10 a server that never answers times out (bounded) and is reported as unconfirmed', out.serverConfirmed === false && !out.hung && Date.now() - t0 < 12000 && !store.has('plumbline_token'));
    S.logoutMode = 'ok';
    out = await api.logout({ markPendingOnFailure: false });
    ok('D11 a confirmed sign-out clears any pending marker', !store.has('plumbline_logout_pending'));
    // Signing in while a "Try again" retry is still in flight.
    store.clear(); store.set('plOnboardingSeen', '1');
    store.set('plumbline_token', seed(1));
    S.logoutMode = 'network';
    await api.logout();
    S.logoutMode = 'hang';
    const retryP = api.retryPendingLogout();
    await settle(30);
    S.logoutMode = 'ok';
    await Promise.race([api.login(S.users[2].email, 'pw'), sleep(12000)]);
    const newTok2 = store.get('plumbline_token');
    await Promise.race([retryP, sleep(12000)]);
    ok('D12 a sign-in made while a sign-out retry is in flight keeps its credential (the late retry does not wipe it or re-arm the marker)',
      store.get('plumbline_token') === newTok2 && !!newTok2 && !store.has('plumbline_logout_pending'));
    await api.logout();
    // An older server's reply (no counts) only confirms what the request itself presented.
    store.clear(); store.set('plOnboardingSeen', '1');
    store.set('plumbline_logout_pending', '1');
    ({ App, api } = loadPage());                      // fresh page: no in-memory credential
    S.logoutMode = 'legacy';
    out = await api.retryPendingLogout();
    S.logoutMode = 'ok';
    ok('D13 an older server\'s bare 200 for a request that carried no credential is NOT a confirmed sign-out',
      out.serverConfirmed === false && out.unverifiable === true);
    // A sign-in waits for a sign-out still in flight (its cleared cookie can never land after the new one).
    store.set('plumbline_token', seed(1));
    let releaseLogout; S.logoutGate = new Promise(r => { releaseLogout = r; });
    m = mark('D14');
    const lo = api.logout();
    await settle(20);
    const li = api.login(S.users[2].email, 'pw');
    await settle(40);
    const loginSentEarly = sinceMark(m).includes('fetch:POST /auth/login');
    releaseLogout(); S.logoutGate = null;
    await lo; await li;
    ev = sinceMark(m);
    ok('D14 a sign-in started while a sign-out is in flight is sent only after that sign-out settled',
      !loginSentEarly && ev.findIndex(e => e.startsWith('logout:')) < ev.indexOf('fetch:POST /auth/login'), ev.join(','));
    await api.logout();
    // A pending marker next to a stored token is stale (a newer sign-in made it obsolete).
    const tD15 = seed(1);
    m = mark('D15');
    await freshApp({ token: tD15, pending: true, reload: true });
    ev = sinceMark(m);
    ok('D15 a stale pending marker (a newer sign-in is stored) never ends that sign-in: it is discarded and the session resumes',
      signedIn() && S.sessions.has(tD15) && !ev.includes('fetch:POST /auth/logout') && !store.has('plumbline_logout_pending'));
    await clickLogout();
    // Another tab signed in while this tab's sign-out was in flight.
    store.set('plumbline_token', seed(1));
    S.logoutGate = new Promise(r => { releaseLogout = r; });
    S.logoutMode = 'network';
    const loD16 = api.logout();
    await settle(20);
    const otherTab = seed(2);
    store.set('plumbline_token', otherTab);            // written by another tab
    releaseLogout(); S.logoutGate = null;
    out = await loD16;
    S.logoutMode = 'ok';
    ok('D16 a sign-out superseded by a sign-in in another tab leaves that sign-in\'s token alone and records no pending marker',
      out.superseded === true && store.get('plumbline_token') === otherTab && !store.has('plumbline_logout_pending'));
    store.delete('plumbline_token');
    // An old session that could not be ended at sign-in is ended on the next attempt.
    ({ App, api } = loadPage());
    const tD17 = seed(1);
    store.set('plumbline_token', tD17);
    S.logoutMode = 'network';
    await api.logout();                                  // unconfirmed: tD17 kept in page memory
    await api.login(S.users[2].email, 'pw');            // its orphan request fails (still offline)
    await settle(20);
    const stillThere = S.sessions.has(tD17);
    S.logoutMode = 'ok';
    const ended17 = await api.endOrphanedSession();
    ok('D17 an old session whose end request failed at sign-in is kept (in memory only) and ended on the next attempt — with only its own token',
      stillThere && ended17 === true && !S.sessions.has(tD17) && sinceMark('D14').some(e => /logout:presented=1:ended=1:omit/.test(e)));
    await api.logout();
    // Another tab changes the token while this page still holds an old session for "Try again".
    await freshApp({ token: seed(1), reload: true });
    const tD18 = store.get('plumbline_token');
    S.logoutMode = 'network';
    await clickLogout();                                 // unconfirmed
    S.logoutMode = 'ok';
    m = mark('D18');
    const se18 = new Event('storage'); se18.key = 'plumbline_token';
    win.dispatchEvent(se18);
    await settle(100);
    ev = sinceMark(m);
    ok('D18 before reloading for another tab\'s sign-in, the page ends the old session it still held (own token only, no cookies)',
      !S.sessions.has(tD18) && ev.some(e => /logout:presented=1:ended=1:omit/.test(e)) && ev.includes('reload'), ev.join(','));

    // ── E. Forced sign-out while running ────────────────────────────────────
    const poll = async () => { globalThis.__refresh = { counts: (globalThis.__refresh?.counts || 0) + 1 }; schedule(); await settle(80); };
    m = mark('E1');
    const tE = seed(1);
    await freshApp({ token: tE });
    S.sessions.delete(tE);                            // revoked / expired server-side
    await poll();
    await waitFor(() => !!loginPage());
    await settle();
    ev = sinceMark(m);
    ok('E1a the forced sign-out tears voice down before its own server request', ev.indexOf('device:destroy:user_1') >= 0
      && ev.indexOf('device:destroy:user_1') < ev.lastIndexOf('fetch:POST /auth/logout'), ev.join(','));
    ok('E1 a background 401 confirmed by /auth/me signs out: Device destroyed, listeners removed, "session ended" notice',
      !!loginPage() && live().length === 0 && listeners().vis === 0 && listeners().focus === 0 && loginPage().props.notice?.kind === 'expired'
      && ev.includes('fetch:GET /auth/me'));
    ok('E2 a forced sign-out does not leave a pending marker (the server already ended that session)', !store.has('plumbline_logout_pending'));
    const tE3 = seed(1);
    await freshApp({ token: tE3 });
    S.sessions.delete(tE3);
    S.meMode = '503';
    await poll();
    await settle(120);
    ok('E3 a 401 followed by a transient /auth/me failure does NOT sign out or touch voice', signedIn() && live().join() === 'user_1');
    S.meMode = 'normal';
    S.sessions.set(tE3, 1);
    S.countsMode = 'disabled';
    await poll();
    await waitFor(() => !!loginPage());
    await settle();
    S.countsMode = 'normal';
    ok('E4 suspended/blocked (401 ACCOUNT_DISABLED): Device destroyed, "account not active" notice', !!loginPage() && live().length === 0 && loginPage().props.notice?.kind === 'disabled');
    m = mark('E5');
    const tE5 = seed(1);
    await freshApp({ token: tE5 });
    S.sessions.delete(tE5);
    win.dispatchEvent(new Event('focus'));
    await waitFor(() => !!loginPage());
    await settle();
    ev = sinceMark(m);
    ok('E5 a 401 on the Voice token refresh tears voice down (before any sign-out request) and signs out ("session ended")',
      !!loginPage() && live().length === 0 && loginPage().props.notice?.kind === 'expired'
      && ev.indexOf('device:destroy:user_1') >= 0 && ev.indexOf('device:destroy:user_1') < ev.lastIndexOf('fetch:POST /auth/logout'), ev.join(','));
    await freshApp({ token: seed(1) });
    S.tokenCode = 'ACCOUNT_DISABLED';
    win.dispatchEvent(new Event('focus'));
    await waitFor(() => !!loginPage());
    await settle();
    S.tokenCode = null;
    ok('E6 a suspension first seen by the Voice token refresh still says "account not active"', loginPage()?.props.notice?.kind === 'disabled' && live().length === 0);
    // A slow /auth/me re-check from the previous sign-in must not end the next one.
    const tE7 = seed(1);
    await freshApp({ token: tE7 });
    let releaseMe; S.meGate = new Promise(r => { releaseMe = r; });
    S.sessions.delete(tE7);
    await poll();                                      // counts 401 → /auth/me re-check now held in flight
    S.meGate = null;                                   // the requests below are not held
    S.sessions.set(tE7, 1);
    await clickLogout();
    await signInAs(2);
    const tE7b = store.get('plumbline_token');
    releaseMe();                                       // the stale re-check (old token) returns 401
    await settle(150);
    ok('E7 a slow 401 re-check left over from the previous sign-in never signs out the next sign-in or ends its session',
      signedIn() && live().join() === 'user_2' && S.sessions.has(tE7b) && loginPage() === null);
    await clickLogout();
    // The suspension is first seen by a request whose caller ignores 401s (a leads refresh).
    await freshApp({ token: seed(1) });
    S.disabled.add(1);
    await api.getLeads().catch(() => {});                // gets ACCOUNT_DISABLED (and the sessions are revoked)
    await poll();                                        // counts: plain 401 → /auth/me: plain 401
    await waitFor(() => !!loginPage());
    await settle();
    S.disabled.delete(1);
    ok('E8 "account not active" is shown even when the suspension was first seen by another request (the server says it only once)',
      loginPage()?.props.notice?.kind === 'disabled');

    // ── F. Failed cold-start authentication ─────────────────────────────────
    m = mark('F1');
    await freshApp({ token: newTok() });          // unknown to the server
    ev = sinceMark(m);
    ok('F1 cold start with an ended session → no Device is ever created, this device is cleaned up, "session ended" notice',
      !signedIn() && !ev.some(e => e.startsWith('device:new')) && ev.includes('fetch:POST /auth/logout') && loginPage()?.props.notice?.kind === 'expired'
      && !store.has('plumbline_token') && !store.has('plumbline_logout_pending'));
    S.meCode = 'ACCOUNT_DISABLED';
    await freshApp({ token: newTok() });
    S.meCode = null;
    ok('F2 cold start for a suspended/blocked account → "account not active" notice, no Device', !signedIn() && loginPage()?.props.notice?.kind === 'disabled' && live().length === 0);
    S.meMode = 'network';
    m = mark('F3');
    await freshApp({ token: seed(1) });
    await waitFor(() => !!loginPage()?.props.notice, 7000);
    S.meMode = 'normal';
    ev = sinceMark(m);
    ok('F3 cold start with the server unreachable → login page with an "offline" notice, no Device, no listeners',
      !signedIn() && loginPage()?.props.notice?.kind === 'offline' && !ev.some(e => e.startsWith('device:new')) && listeners().vis === 0);
    // Gated screens: no Voice device while a paywall or the number picker is shown.
    m = mark('F4');
    await freshApp({ token: seed(3) });
    await settle(80);
    ev = sinceMark(m);
    ok('F4 no Voice device is registered while the paywall is shown (no call UI there)', !!find(byName('PaywallGate')) && !ev.some(e => e.startsWith('device:new')));
    m = mark('F5');
    await freshApp({ token: seed(4) });
    await settle(80);
    ev = sinceMark(m);
    ok('F5 no Voice device is registered while the number picker is shown', !!find(byName('NumberPickerModal')) && !ev.some(e => e.startsWith('device:new')));

    // ── G. Races, idempotence, stale events, alerts, other tabs ─────────────
    let release;
    S.tokenGate = new Promise(r => { release = r; });
    const tG = seed(1);
    if (R.root) unmount();
    store.clear(); store.set('plOnboardingSeen', '1'); store.set('plumbline_token', tG);
    m = mark('G1');
    mount(App);
    await waitFor(() => signedIn() && S.tokenRequests > 0);
    await logoutButton().props.onClick();
    release();
    S.tokenGate = null;
    await settle(120);
    ev = sinceMark(m);
    ok('G1 logout while the Voice token request is still in flight: when it returns, no Device is built or registered',
      !ev.some(e => e.startsWith('device:new')) && live().length === 0);
    S.tokenIdentityOverride = 'user_99';
    m = mark('G2');
    await freshApp({ token: seed(1) });
    await settle(80);
    S.tokenIdentityOverride = null;
    ev = sinceMark(m);
    ok('G2 a Voice token for a different identity is never used (no Device for user_99)', !ev.some(e => e.startsWith('device:new')) && live().length === 0);
    await freshApp({ token: seed(1) });
    const vd = voiceProp();
    const dBefore = Fake.destroyCalls;
    let threw = false;
    try { vd.teardown('t1'); vd.teardown('t2'); vd.teardown('t3'); } catch { threw = true; }
    await settle();
    ok('G3 teardown is idempotent: repeated calls never throw and destroy the Device exactly once', !threw && Fake.destroyCalls === dBefore + 1 && live().length === 0);
    if (R.root) unmount();
    store.clear(); store.set('plOnboardingSeen', '1');
    S.meMode = '503';
    mount(App);
    await settle(30);
    const vd0 = voiceProp();
    S.meMode = 'normal';
    let threw0 = false;
    try { vd0.teardown('never-initialized'); vd0.teardown('again'); } catch { threw0 = true; }
    ok('G4 teardown is safe when initialization never happened', !!vd0 && !threw0);
    unmount();
    await settle(4200);
    await freshApp({ token: seed(1) });
    const dev = Fake.devices.filter(d => !d.destroyed).at(-1);
    const call = new FakeCall({ From: '+15550000001' });
    m = mark('G5');
    dev.emit('incoming', call);
    await settle(900);
    const flashed = doc.title !== 'PlumbLine Leads' || sinceMark(m).includes('ringtone:play');
    await clickLogout();
    const titleAfter = doc.title;
    await settle(1700);
    ok('G5 an incoming call\'s ringtone/title flash (observed) is stopped by sign-out and the title restored (no flashing afterwards)',
      flashed && titleAfter === 'PlumbLine Leads' && doc.title === 'PlumbLine Leads');
    await freshApp({ token: seed(1) });
    const r0 = reloads;
    m = mark('G6');
    const se = new Event('storage'); se.key = 'plumbline_token';
    win.dispatchEvent(se);
    await settle();
    ev = sinceMark(m);
    ok('G6 another tab signing in/out (stored token changed) tears voice down and reloads this tab', reloads === r0 + 1 && ev.includes('device:destroy:user_1') && live().length === 0);
    // Media: queued and in-flight requests at sign-out resolve to nothing.
    await freshApp({ token: seed(1) });
    const pendingUrl = api.requestMediaUrl('call-recording', 1, 0);
    api.clearLocalAuth();
    ok('G7 media requests queued at sign-out resolve to nothing (no late URL for the old session)',
      (await Promise.race([pendingUrl, sleep(2000).then(() => 'hung')])) === null);
    store.set('plumbline_token', seed(1));
    let releaseTickets; S.ticketGate = new Promise(r => { releaseTickets = r; });
    const inflight = api.requestMediaUrl('call-recording', 2, 0, { fresh: true });
    await settle(40);                                 // the batch is now in flight
    api.clearLocalAuth();
    releaseTickets(); S.ticketGate = null;
    ok('G7b a ticket batch already in flight at sign-out is discarded when it returns', (await Promise.race([inflight, sleep(2000).then(() => 'hung')])) === null);
    const u = await api.login(S.users[1].email, 'pw');
    ok('G8 login() keeps the token in storage only — the returned user object has none', !('token' in u) && tokRe(store.get('plumbline_token')));
    await api.logout();
    // Direct account change on the voice hook.
    await freshApp({ token: seed(1) });
    const v2 = voiceProp();
    S.sessions.set(store.get('plumbline_token'), 2);
    m = mark('G11');
    await v2.initialize(2);
    await settle();
    ev = sinceMark(m);
    ok('G11 initialize(newAccount) with a live Device for another account destroys it first and builds exactly one for the new identity',
      ev.indexOf('device:destroy:user_1') >= 0 && ev.indexOf('device:destroy:user_1') < ev.indexOf('device:new:user_2')
      && live().join() === 'user_2', ev.join(','));
    await freshApp({ token: seed(1) });
    const v3 = voiceProp();
    await clickLogout();
    m = mark('G13');
    await v3.retryVoiceSession();
    win.dispatchEvent(new Event('focus'));
    await settle(80);
    ev = sinceMark(m);
    ok('G13 after sign-out, Retry / focus never fetch a Voice token or build a Device', !ev.includes('fetch:GET /api/twilio/token') && !ev.some(e => e.startsWith('device:new')), ev.join(','));
    await freshApp({ token: seed(1) });
    const v4 = voiceProp();
    let releaseHealth; S.healthGate = new Promise(r => { releaseHealth = r; });
    m = mark('G14');
    const calling = v4.makeCall('5550000001');
    await settle(30);
    await clickLogout();
    releaseHealth(); S.healthGate = null;
    await calling;
    await settle(50);
    ev = sinceMark(m);
    ok('G14 an outbound call waiting on backend warm-up is never placed once the user has signed out', !ev.some(e => e.startsWith('device:connect')), ev.join(','));
    // Signed out AND another account signed in during the warm-up: the call
    // must never go out on the new account's Device.
    await freshApp({ token: seed(1) });
    const v4c = voiceProp();
    S.healthGate = new Promise(r => { releaseHealth = r; });
    m = mark('G14c');
    const calling3 = v4c.makeCall('5550000004');
    await settle(30);
    await clickLogout();
    await signInAs(2);
    releaseHealth(); S.healthGate = null;
    await calling3;
    await settle(30);
    ev = sinceMark(m);
    ok('G14c a call started by one account is never placed on the next account\'s Device when they switch during the warm-up',
      !ev.some(e => e.startsWith('device:connect')), ev.join(','));
    await clickLogout();
    // Same account, Device rebuilt during the warm-up: the call goes out on the live Device.
    await freshApp({ token: seed(1) });
    const v4b = voiceProp();
    S.healthGate = new Promise(r => { releaseHealth = r; });
    m = mark('G14b');
    const calling2 = v4b.makeCall('5550000003');
    await settle(30);
    await voiceProp().retryVoiceSession();            // transport recovery → a new Device for user_1
    await settle(30);
    releaseHealth(); S.healthGate = null;
    await calling2;
    await settle(30);
    ev = sinceMark(m);
    const liveDev = Fake.devices.filter(d => !d.destroyed).at(-1);
    ok('G14b if the Device was rebuilt for the same sign-in during warm-up, the call is placed on the live Device (not dropped)',
      ev.filter(e => e.startsWith('device:new:user_1')).length === 1 && ev.includes('device:connect:user_1') && liveDev && !liveDev.destroyed, ev.join(','));
    Fake.calls.at(-1)?.emit('disconnect');
    await settle(1600);
    await freshApp({ token: seed(1) });
    const v5 = voiceProp();
    await v5.makeCall('5550000002');
    await settle(30);
    const oc = Fake.calls.at(-1);
    oc.emit('accept');
    await settle(20);
    await clickLogout();
    await signInAs(2);
    m = mark('G15');
    oc.emit('disconnect');
    await settle(80);
    ev = sinceMark(m);
    ok('G15 a call\'s late disconnect after sign-out logs nothing and prompts nothing under the new account',
      !ev.includes('ensure-logged') && !voiceProp().pendingPostCallNote, ev.join(','));
    await clickLogout();
    // A microphone prompt answered after sign-out does not carry into the next sign-in.
    let answerMic;
    let probes = 0;
    globalThis.navigator = { ...navigatorBase, mediaDevices: { getUserMedia: () => { probes++; return new Promise((_, rej) => { answerMic = () => rej(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); }); } } };
    await freshApp({ token: seed(1) });
    const v6 = voiceProp();
    const probing = v6.retryMicPermission('try_again');
    await settle(20);
    await clickLogout();
    answerMic();
    await probing;
    await signInAs(2);
    const probesBefore = probes;
    win.dispatchEvent(new Event('focus'));
    await settle(80);
    ok('G16 a microphone prompt answered after sign-out raises no warning in the next sign-in and triggers no probes there',
      voiceProp().micBlocked === false && probes === probesBefore);
    globalThis.navigator = { ...navigatorBase };
    await clickLogout();
    ok('G9 no session token appears in any console line', !logged.some(l => /pl1_[A-Za-z0-9_-]{43}/.test(l)));
    ok('G10 the hook runtime recorded no render errors', R.errors.length === 0 && R.hookCountErrors === 0, String(R.errors[0] || ''));
    if (R.root) unmount();

    // ── H. makeCall(): the sign-in ends while connect() is still pending ─────
    // Fake.connectGate holds the fake Device's connect() open while something
    // ends that sign-in (or replaces its Device); then connect() settles late.
    // A late call must be hung up, never become the active call, carry no
    // handlers, and leave the next sign-in alone. Fake calls only — none real.
    const holdConnect = () => { let open; Fake.connectGate = new Promise(r => { open = r; }); return (outcome) => { Fake.connectGate = null; open(outcome); }; };
    async function pendingCall(digits) {
      const n = events.length, logN = logged.length;
      const settleConnect = holdConnect();
      const calls0 = Fake.calls.length;
      const placing = voiceProp().makeCall(digits);
      const reached = await waitFor(() => events.slice(n).some(e => e.startsWith('device:connect:')));
      await settle(10);
      if (!reached || Fake.calls.length !== calls0) throw new Error(`pendingCall(${digits}): connect() is not pending`);
      return { placing, settleConnect, logN };
    }
    async function lateResolve(p) { const n = Fake.calls.length; p.settleConnect(); await p.placing; await settle(30); return Fake.calls[n] || null; }
    // Returns true once the rejection has reached makeCall's catch (its log line).
    async function lateReject(p, err) {
      p.settleConnect(err); await p.placing; await settle(60);
      return logged.slice(p.logN).some(l => l.includes('makeCall failed'));
    }
    // The reason the dropped-call log line gives (diagnostics), since logN.
    const reasons = [];
    const noteReason = (id, logN, want) => {
      const line = logged.slice(logN).filter(l => l.includes('outbound call dropped')).at(-1);
      reasons.push({ id, want, got: (line && /"reason":"(\w+)"/.exec(line)?.[1]) || null });
    };
    async function lateEvents(c) {
      if (!c) return;
      for (const e of ['ringing', 'accept', 'disconnect', 'cancel']) c.emit(e);
      c.emit('error', Object.assign(new Error('late call error'), { code: 31005 }));
      await settle(60);
    }
    const dropped = (c) => !!c && c.disconnects === 1 && c.listenerTotal() === 0;
    const quiet = (v) => !!v && v.activeCall === null && v.error === null && !v.pendingPostCallNote && v.micBlocked === false;
    const ERR_NOT_CONNECTED = 'Call did not connect. Please try again.';
    const liveDevice = () => Fake.devices.filter(d => !d.destroyed).at(-1);
    const replaceDevice = async () => {
      const old = liveDevice();
      await voiceProp().retryVoiceSession();             // hard transport recovery: same sign-in, new Device
      await waitFor(() => old.destroyed && live().length === 1);
      await settle(30);
      return { old, now: liveDevice() };
    };
    const transportErr = () => Object.assign(new Error('Transport error'), { code: 31009 });

    // Explicit logout.
    await freshApp({ token: seed(1) });
    let p = await pendingCall('5550000011');
    m = mark('H1');
    await clickLogout();                                 // teardown runs three times on this path
    let c = await lateResolve(p);
    noteReason('H1', p.logN, 'voice_torn_down');
    let v = voiceProp();
    ok('H1 logout while connect() is pending: the late call is hung up exactly once, never becomes the active call and gets no handlers; voice stays off',
      dropped(c) && quiet(v) && v.status === 'idle' && !!loginPage() && live().length === 0,
      JSON.stringify({ d: c?.disconnects, l: c?.listenerTotal(), s: v?.status, a: !!v?.activeCall }));
    await lateEvents(c);
    let threwH = false;
    try { v.teardown('again'); v.teardown('again'); } catch { threwH = true; }
    await settle(20);
    ev = sinceMark(m);
    v = voiceProp();
    ok('H1b that call\'s late events change nothing (no call log, note, status or error) and further teardowns are harmless no-ops',
      !threwH && !ev.includes('ensure-logged') && quiet(v) && v.status === 'idle' && c?.disconnects === 1, ev.join(','));

    // Forced sign-out: a background 401 confirmed by /auth/me.
    const tH2 = seed(1);
    await freshApp({ token: tH2 });
    p = await pendingCall('5550000012');
    m = mark('H2');
    S.sessions.delete(tH2);
    await poll();
    await waitFor(() => !!loginPage());
    await settle();
    c = await lateResolve(p);
    await lateEvents(c);
    ev = sinceMark(m);
    v = voiceProp();
    ok('H2 forced 401 sign-out while connect() is pending: the late call is hung up and unwired, its late events do nothing, "session ended" shown',
      dropped(c) && quiet(v) && v.status === 'idle' && loginPage()?.props.notice?.kind === 'expired' && !ev.includes('ensure-logged'), ev.join(','));

    // Voice-token rejection while connect() is pending: a manual Retry (which,
    // unlike automatic refreshes, still runs while a call is only dialing) gets a 401.
    const tH2b = seed(1);
    await freshApp({ token: tH2b });
    p = await pendingCall('5550000021');
    m = mark('H2b');
    S.sessions.delete(tH2b);
    voiceProp().retryVoiceSession();                     // recovery → Voice token 401 → authLost
    await waitFor(() => !!loginPage());
    await settle();
    c = await lateResolve(p);
    await lateEvents(c);
    ev = sinceMark(m);
    v = voiceProp();
    ok('H2b Voice-token 401 while connect() is pending: signed out, the late call is hung up and unwired, its late events do nothing',
      dropped(c) && quiet(v) && v.status === 'idle' && loginPage()?.props.notice?.kind === 'expired' && !ev.includes('ensure-logged')
      && ev.indexOf('fetch:GET /api/twilio/token') >= 0 && ev.indexOf('fetch:GET /api/twilio/token') < ev.indexOf('device:destroy:user_1'), ev.join(','));

    // Account change: account 2 signs in (and is being rung) when account 1's call settles.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000013');
    await clickLogout();
    await signInAs(2);
    const dev2 = liveDevice();
    const inbound2 = new FakeCall({ From: '+15550000222' });
    dev2.emit('incoming', inbound2);
    await settle(20);
    m = mark('H3');
    c = await lateResolve(p);
    noteReason('H3', p.logN, 'voice_torn_down');
    v = voiceProp();
    ok('H3 account change while connect() is pending: account 1\'s late call is hung up and unwired and never becomes account 2\'s active call; account 2\'s ringing inbound call is untouched',
      dropped(c) && v.activeCall === null && v.status === 'incoming' && v.incomingCall === inbound2 && v.error === null
      && live().join() === 'user_2' && !dev2.destroyed, JSON.stringify({ s: v.status, d: c?.disconnects, l: c?.listenerTotal() }));
    await lateEvents(c);
    ev = sinceMark(m);
    v = voiceProp();
    ok('H3b account 1\'s late call events never log, prompt, fail or touch Devices under account 2',
      !ev.includes('ensure-logged') && v.status === 'incoming' && v.incomingCall === inbound2 && v.error === null && !v.pendingPostCallNote
      && !ev.some(e => e.startsWith('device:')) && !dev2.destroyed, ev.join(','));
    v.rejectCall();
    await clickLogout();
    // Account change on the voice hook itself (initialize for another account).
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000014');
    S.sessions.set(store.get('plumbline_token'), 2);
    await voiceProp().initialize(2);
    await waitFor(() => live().join() === 'user_2');
    await settle();
    const dev3c = liveDevice();
    c = await lateResolve(p);
    v = voiceProp();
    ok('H3c initialize(otherAccount) while connect() is pending: the late call is hung up and unwired; the new account\'s Device and dialer are untouched',
      dropped(c) && quiet(v) && v.status === 'ready' && liveDevice() === dev3c && !dev3c.destroyed && live().join() === 'user_2', JSON.stringify({ s: v.status }));
    // … and while account 2's Voice device is still registering.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000036');
    await clickLogout();
    let releaseTokH3; S.tokenGate = new Promise(r => { releaseTokH3 = r; });
    const u2H3 = await api.login(S.users[2].email, 'pw');
    await loginPage().props.onSuccess(u2H3);
    const registeringH3 = await waitFor(() => voiceProp()?.status === 'registering' && S.tokenRequests > 0);
    c = await lateResolve(p);
    const sDuringH3 = voiceProp().status;
    releaseTokH3(); S.tokenGate = null;
    await waitFor(() => live().join() === 'user_2');
    await settle();
    ok('H3d account 1\'s late call leaves account 2\'s dialer alone while its Voice device is still registering',
      registeringH3 && dropped(c) && sDuringH3 === 'registering' && voiceProp().status === 'ready' && quiet(voiceProp()), JSON.stringify({ sDuringH3 }));
    await clickLogout();

    // Another tab: its storage event arrives while connect() is pending …
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000015');
    let r0H = reloads;
    let seH = new Event('storage'); seH.key = 'plumbline_token';
    win.dispatchEvent(seH);
    await settle();
    c = await lateResolve(p);
    v = voiceProp();
    ok('H4 another tab changes the sign-in while connect() is pending: voice torn down and the tab reloads; the late call is hung up and unwired',
      dropped(c) && quiet(v) && v.status === 'idle' && reloads === r0H + 1 && live().length === 0);
    // … or the stored credential has already changed, but its storage event has not reached this tab yet.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000016');
    store.set('plumbline_token', seed(2));                // another tab signed in as account 2
    c = await lateResolve(p);
    noteReason('H4b', p.logN, 'session_changed');
    v = voiceProp();
    ok('H4b the stored credential changed before its storage event arrived (only the credential differs): the late call is hung up and unwired, and the dialer is released (not left "dialing")',
      dropped(c) && quiet(v) && v.status === 'ready', JSON.stringify({ s: v.status, d: c?.disconnects, l: c?.listenerTotal() }));
    r0H = reloads;
    seH = new Event('storage'); seH.key = 'plumbline_token';
    win.dispatchEvent(seH);
    await settle();
    ok('H4c when that storage event does arrive, voice is torn down and the tab reloads as usual', reloads === r0H + 1 && live().length === 0);

    // Device replaced for the same sign-in (transport recovery) while connect() is pending.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000017');
    let swap = await replaceDevice();
    m = mark('H5');
    c = await lateResolve(p);
    noteReason('H5', p.logN, 'device_replaced');
    ev = sinceMark(m);
    v = voiceProp();
    ok('H5 Device replaced while connect() is pending: the call of the destroyed Device is hung up and unwired, the attempt is reported as not connected, the new Device is kept (no second recovery)',
      dropped(c) && v.activeCall === null && v.status === 'failed' && v.error === ERR_NOT_CONNECTED
      && swap.now !== swap.old && !swap.now.destroyed && live().join() === 'user_1' && !ev.some(e => e.startsWith('device:')), ev.join(','));
    await clickLogout();
    // A dropped attempt never settles the dialer over a call that went live meanwhile.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000034');
    swap = await replaceDevice();
    const inb5 = new FakeCall({ From: '+15550000555' });
    swap.now.emit('incoming', inb5);                    // rings on the new Device
    await settle(20);
    c = await lateResolve(p);
    v = voiceProp();
    const keptOnReplace = dropped(c) && v.status === 'incoming' && v.incomingCall === inb5;
    v.rejectCall();
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000035');
    const inb4 = new FakeCall({ From: '+15550000444' });
    liveDevice().emit('incoming', inb4);
    await settle(20);
    store.set('plumbline_token', seed(2));                // another tab, before its storage event
    c = await lateResolve(p);
    v = voiceProp();
    const keptOnSession = dropped(c) && v.status === 'incoming' && v.incomingCall === inb4;
    ok('H5b a dropped attempt never settles the dialer over an inbound call ringing meanwhile (on the replaced Device, or before another tab\'s storage event)',
      keptOnReplace && keptOnSession, JSON.stringify({ keptOnReplace, keptOnSession }));
    v.rejectCall();

    // Component unmount while connect() is pending.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000018');
    const errsH6 = R.errors.length;
    m = mark('H6');
    unmount();
    c = await lateResolve(p);
    await lateEvents(c);
    ev = sinceMark(m);
    ok('H6 unmount while connect() is pending: the Device is destroyed, the late call is hung up and unwired, nothing renders or throws afterwards',
      dropped(c) && live().length === 0 && R.root === null && R.errors.length === errsH6 && !ev.includes('ensure-logged'), ev.join(','));

    // Late rejections.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000019');
    await clickLogout();
    let caught = await lateReject(p, Object.assign(new Error('Call declined'), { code: 31002 }));
    noteReason('H7', p.logN, 'voice_torn_down');
    v = voiceProp();
    ok('H7 connect() rejecting after logout raises no error or failure state', caught && quiet(v) && v.status === 'idle', JSON.stringify({ caught, s: v.status, e: v.error }));
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000020');
    await clickLogout();
    caught = await lateReject(p, Object.assign(new Error('Permission denied'), { code: 31401, name: 'NotAllowedError' }));
    const micAfterLogout = voiceProp().micBlocked;
    await signInAs(2);
    ok('H7b a microphone denial that settles after logout raises no mic warning, then or in the next sign-in',
      caught && micAfterLogout === false && voiceProp().micBlocked === false);
    await clickLogout();
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000022');
    await clickLogout();
    await signInAs(2);
    const dev2c = liveDevice();
    m = mark('H7c');
    caught = await lateReject(p, transportErr());
    ev = sinceMark(m);
    v = voiceProp();
    ok('H7c account 1\'s late transport failure starts no recovery on account 2\'s Device and shows nothing there',
      caught && !dev2c.destroyed && liveDevice() === dev2c && !ev.some(e => e.startsWith('device:')) && !ev.includes('fetch:GET /api/twilio/token')
      && quiet(v) && v.status === 'ready', ev.join(','));
    await clickLogout();
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000023');
    swap = await replaceDevice();
    m = mark('H7d');
    caught = await lateReject(p, transportErr());
    noteReason('H7d', p.logN, 'device_replaced');
    ev = sinceMark(m);
    v = voiceProp();
    ok('H7d the replaced Device\'s late transport failure starts no second recovery; the attempt is reported as not connected',
      caught && !swap.now.destroyed && !ev.some(e => e.startsWith('device:')) && !ev.includes('fetch:GET /api/twilio/token')
      && v.status === 'failed' && v.error === ERR_NOT_CONNECTED, ev.join(','));
    await clickLogout();
    // A late transport failure after every other way a sign-in can end (or change).
    const endings = {
      forced401: async () => { S.sessions.delete(store.get('plumbline_token')); await poll(); await waitFor(() => !!loginPage()); await settle(); },
      voiceToken401: async () => { S.sessions.delete(store.get('plumbline_token')); voiceProp().retryVoiceSession(); await waitFor(() => !!loginPage()); await settle(); },
      initializeOther: async () => { S.sessions.set(store.get('plumbline_token'), 2); await voiceProp().initialize(2); await waitFor(() => live().join() === 'user_2'); await settle(); },
      otherTabEvent: async () => { const e = new Event('storage'); e.key = 'plumbline_token'; win.dispatchEvent(e); await settle(); },
      otherTabNoEventYet: async () => { store.set('plumbline_token', seed(2)); },
      unmount: async () => { unmount(); },
    };
    const lateFailures = [];
    for (const [name, end] of Object.entries(endings)) {
      await freshApp({ token: seed(1) });
      p = await pendingCall('5550000028');
      await end();
      const after = liveDevice() || null;
      const vEnd = voiceProp();                           // null after unmount
      m = mark(`H7e:${name}`);
      caught = await lateReject(p, transportErr());
      ev = sinceMark(m);
      v = voiceProp();
      const okOne = caught && (liveDevice() || null) === after && !ev.some(e => e.startsWith('device:')) && !ev.includes('fetch:GET /api/twilio/token')
        && (v === null ? vEnd === null : (quiet(v) && v.status === (vEnd.status === 'idle' ? 'idle' : 'ready')));
      lateFailures.push({ name, ok: okOne, ev: ev.join(','), s: v?.status, e: v?.error });
    }
    ok('H7e a late transport failure after a forced 401, a Voice-token 401, initialize(other), another tab (with or before its storage event) or unmount starts no recovery and shows nothing',
      lateFailures.every(x => x.ok), JSON.stringify(lateFailures.filter(x => !x.ok)));
    // A rejection without a reason (signalling closed while connect() waited).
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000033');
    await clickLogout();
    let threwG = false;
    try { caught = await lateReject(p, Fake.REJECT_UNDEFINED); } catch { threwG = true; caught = false; }
    v = voiceProp();
    ok('H7g a rejection without a reason after logout is handled quietly: makeCall settles (no unhandled rejection), nothing is shown',
      !threwG && caught && quiet(v) && v.status === 'idle', JSON.stringify({ threwG, caught, s: v.status }));
    // A microphone denial is still shown when only the Device was replaced (same sign-in).
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000029');
    swap = await replaceDevice();
    m = mark('H7f');
    caught = await lateReject(p, Object.assign(new Error('Permission denied'), { code: 31401, name: 'NotAllowedError' }));
    ev = sinceMark(m);
    v = voiceProp();
    ok('H7f a microphone denial on a call whose Device was replaced for the same sign-in still raises the mic card (no recovery, no generic error)',
      caught && v.micBlocked === true && v.error === null && v.status === 'ready' && !ev.some(e => e.startsWith('device:')), JSON.stringify({ s: v.status, e: v.error, mic: v.micBlocked }));
    v.dismissMicWarning();
    await clickLogout();

    // Teardown inside the window between the final check and handler registration / state.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000024');
    Fake.onCall = (call) => {
      Fake.onCall = null;
      call.onAttach = () => { const e = new Event('storage'); e.key = 'plumbline_token'; win.dispatchEvent(e); };   // teardown, synchronously
    };
    r0H = reloads;
    m = mark('H8');
    c = await lateResolve(p);
    noteReason('H8', p.logN, 'voice_torn_down');
    v = voiceProp();
    ok('H8 a teardown landing while the call\'s handlers are being attached (after the final check): the call is hung up and is not left as the active call',
      !!c && c.disconnects >= 1 && c.status() === 'closed' && v.activeCall === null && v.status === 'idle' && reloads === r0H + 1 && live().length === 0,
      JSON.stringify({ d: c?.disconnects, a: !!v.activeCall, s: v.status }));
    await lateEvents(c);
    ev = sinceMark(m);
    v = voiceProp();
    ok('H8b the handlers attached in that window are inert: the call\'s later events log, prompt and change nothing',
      c?.listenerTotal() > 0 && !ev.includes('ensure-logged') && quiet(v) && v.status === 'idle', ev.join(','));

    // Positive: a current call still connects normally after a slow connect().
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000025');
    m = mark('H9');
    c = await lateResolve(p);
    v = voiceProp();
    const wired = ['ringing', 'accept', 'disconnect', 'cancel', 'error'].every(e => (c?.listeners[e] || []).length === 1);
    ok('H9 a call for the current sign-in, account, credential and Device connects normally after a slow connect(): active, wired once, not hung up',
      !!c && v.activeCall === c && wired && c.disconnects === 0 && v.status === 'dialing' && v.remoteIdentity === '+15550000025' && v.error === null,
      JSON.stringify({ s: v.status, wired, d: c?.disconnects }));
    c?.emit('ringing'); await settle(10);
    const sRinging = voiceProp().status;
    c?.emit('accept'); await settle(10);
    const sConnected = voiceProp().status;
    await sleep(3100);                                   // past MIN_REAL_CALL_MS
    c?.emit('disconnect'); await settle(60);
    ev = sinceMark(m);
    v = voiceProp();
    ok('H9b that call goes ringing → connected → ended, is logged, and the post-call note is offered',
      sRinging === 'ringing' && sConnected === 'connected' && v.status === 'ended' && ev.includes('ensure-logged')
      && v.pendingPostCallNote?.phone === '+15550000025' && v.activeCall === null && c?.disconnects === 0, JSON.stringify({ sRinging, sConnected, s: v.status }));
    v.clearPostCallNote();
    await settle(1600);
    // A token refresh while connect() is pending waits for the call, then runs.
    p = await pendingCall('5550000026');
    const devH9 = liveDevice();
    const upd0 = Fake.updateTokens;
    win.dispatchEvent(new Event('focus'));
    await settle(60);
    const sDuringRefresh = voiceProp().status, updDuring = Fake.updateTokens;
    c = await lateResolve(p);
    v = voiceProp();
    const keptH9c = liveDevice() === devH9 && !!c && v.activeCall === c && c.disconnects === 0 && c.listenerTotal() === 6;
    c?.emit('disconnect');
    await settle(40);
    const sEnded = voiceProp().status, updEnded = Fake.updateTokens;
    await waitFor(() => Fake.updateTokens > upd0, 4000);
    await settle(60);
    ok('H9c a token refresh while connect() is pending waits (dialer stays "dialing", no token update), keeps the call, and runs once the call has ended and shown "ended"',
      sDuringRefresh === 'dialing' && updDuring === upd0 && keptH9c && sEnded === 'ended' && updEnded === upd0
      && Fake.updateTokens === upd0 + 1 && voiceProp().status === 'ready' && liveDevice() === devH9,
      JSON.stringify({ sDuringRefresh, updDuring, upd0, sEnded, now: Fake.updateTokens, s: voiceProp().status, keptH9c }));
    // A current call whose connect() fails is still reported exactly as before.
    p = await pendingCall('5550000030');
    caught = await lateReject(p, Object.assign(new Error('Call declined'), { code: 31002 }));
    v = voiceProp();
    const genericFail = caught && v.status === 'failed' && v.error === 'Call declined' && v.activeCall === null;
    p = await pendingCall('5550000031');
    caught = await lateReject(p, Object.assign(new Error('Permission denied'), { code: 31401, name: 'NotAllowedError' }));
    v = voiceProp();
    const micFail = caught && v.micBlocked === true && v.error === null && v.status === 'ready';
    v.dismissMicWarning();
    await settle();
    const devH9d = liveDevice();
    p = await pendingCall('5550000032');
    m = mark('H9d');
    caught = await lateReject(p, transportErr());
    await waitFor(() => devH9d.destroyed && live().length === 1);
    await settle(30);
    ev = sinceMark(m);
    const recovered = caught && ev.includes('fetch:GET /api/twilio/token') && ev.includes('device:destroy:user_1') && ev.includes('device:new:user_1')
      && voiceProp().status === 'ready';
    ok('H9d a current call whose connect() fails is reported as before: the error, the mic card, or a transport recovery',
      genericFail && micFail && recovered, JSON.stringify({ genericFail, micFail, recovered }));
    await clickLogout();

    // The final check before connect(): the credential changed during the warm-up.
    await freshApp({ token: seed(1) });
    S.healthGate = new Promise(r => { releaseHealth = r; });
    m = mark('H10');
    const logH10 = logged.length;
    const placingH10 = voiceProp().makeCall('5550000027');
    await settle(30);
    store.set('plumbline_token', seed(2));                // another tab; its storage event not delivered yet
    releaseHealth(); S.healthGate = null;
    await placingH10;
    await settle(30);
    noteReason('H10', logH10, 'session_changed');
    ev = sinceMark(m);
    v = voiceProp();
    ok('H10 the stored credential changed during the warm-up: the call is never placed, and the dialer is released without an error',
      !ev.some(e => e.startsWith('device:connect')) && quiet(v) && v.status === 'ready', ev.join(','));
    if (R.root) unmount();

    // The decision itself: each input alone decides.
    const why = voiceHook.outboundCallStaleReason;
    const DH = {}, DH2 = {}, AT = {};
    const base = { generation: 3, userId: 1, credential: 'cred-a', device: DH, attempt: AT };
    const decisions = [
      [{}, null],
      [{ generation: 4 }, 'voice_torn_down'],
      [{ userId: null }, 'account_changed'], [{ userId: 2 }, 'account_changed'],
      [{ credential: null }, 'session_changed'], [{ credential: 'cred-b' }, 'session_changed'],
      [{ attempt: null }, 'attempt_ended'], [{ attempt: {} }, 'attempt_ended'],
      [{ device: null }, 'device_replaced'], [{ device: DH2 }, 'device_replaced'],
    ].map(([d, want]) => ({ d: Object.keys(d).join() || 'none', got: why(base, { ...base, ...d }), want }));
    ok('H11 outboundCallStaleReason: generation, account, credential, attempt lock and Device each decide on their own; nothing changed → still current',
      decisions.every(x => x.got === x.want), JSON.stringify(decisions.filter(x => x.got !== x.want)));
    ok('H11b an attempt that began with voice off (no account) is never current', why({ ...base, userId: null }, { ...base, userId: null }) === 'account_changed');
    ok('H13 each dropped attempt\'s log line names why (torn down / session changed / Device replaced)',
      reasons.length === 8 && reasons.every(r => r.got === r.want), JSON.stringify(reasons.filter(r => r.got !== r.want)));
    ok('H12 no session token appears in any console line (incl. the dropped-call log), and no render errors',
      !logged.some(l => /pl1_[A-Za-z0-9_-]{43}/.test(l)) && R.errors.length === 0 && R.hookCountErrors === 0, String(R.errors[0] || ''));

    // ── I. Outbound call state while dialing ─────────────────────────────────
    // Refresh and recovery wait for an outbound call that is dialing, ringing
    // or connected, and run once it ends; one attempt at a time, released only
    // by the attempt holding the lock; connect() failures without a reason
    // settle. Fake calls only.
    const countEv = (list, pred) => list.filter(pred).length;
    const ignoredSince = (n) => logged.slice(n).filter(l => l.includes('makeCall ignored')).length;

    // Token refreshes while connect() is pending and while the call rings.
    await freshApp({ token: seed(1) });
    let devI = liveDevice();
    const updI1 = Fake.updateTokens;
    p = await pendingCall('5550000040');
    m = mark('I1');
    win.dispatchEvent(new Event('focus'));
    devI.emit('tokenWillExpire');
    await settle(60);
    const sPendingI1 = voiceProp().status;
    c = await lateResolve(p);
    c?.emit('ringing'); await settle(10);
    win.dispatchEvent(new Event('focus'));
    devI.emit('error', Object.assign(new Error('AccessTokenExpired'), { code: 20104 }));
    await settle(60);
    ev = sinceMark(m);
    v = voiceProp();
    ok('I1 token refreshes (focus, tokenWillExpire, 20104) while connect() is pending or the call rings wait: the dialer keeps "dialing" then "ringing", no token is fetched or applied, the call stays up',
      sPendingI1 === 'dialing' && v.status === 'ringing' && !!c && v.activeCall === c && c.disconnects === 0 && Fake.updateTokens === updI1
      && !ev.includes('fetch:GET /api/twilio/token') && !ev.some(e => e.startsWith('device:')), JSON.stringify({ sPendingI1, s: v.status, ev }));
    c?.emit('accept'); await settle(10);
    m = mark('I1b');
    c?.emit('disconnect'); await settle(40);
    const sEndedI1 = voiceProp().status;
    await waitFor(() => Fake.updateTokens > updI1, 4000);
    await settle(80);
    ev = sinceMark(m);
    ok('I1b once that call has ended (and shown "ended"), the waiting refresh runs exactly once, on the same Device',
      sEndedI1 === 'ended' && Fake.updateTokens === updI1 + 1 && countEv(ev, e => e === 'fetch:GET /api/twilio/token') === 1
      && liveDevice() === devI && voiceProp().status === 'ready', JSON.stringify({ sEndedI1, upd: Fake.updateTokens - updI1, ev }));

    // Transport-recovery triggers while connect() is pending, ringing and connected.
    await freshApp({ token: seed(1) });
    devI = liveDevice();
    const updI2 = Fake.updateTokens;
    p = await pendingCall('5550000042');
    m = mark('I2');
    devI.emit('offline');
    devI.emit('unregistered');                             // not our own destroy
    devI.emit('error', transportErr());
    win.dispatchEvent(new Event('focus'));                 // a refresh too: the recovery covers it
    await settle(60);
    const sPendingI2 = voiceProp().status;
    c = await lateResolve(p);
    c?.emit('ringing'); await settle(10);
    devI.emit('offline'); await settle(30);
    const sRingingI2 = voiceProp().status;
    c?.emit('accept'); await settle(10);
    devI.emit('offline'); devI.emit('registered'); await settle(30);
    const sConnectedI2 = voiceProp().status;
    ev = sinceMark(m);
    ok('I2 recovery triggers (offline, unexpected unregister, 31009) while connect() is pending, ringing or connected wait: no Device destroyed, no token fetched, the dialer keeps "dialing" → "ringing" → "connected", the call stays up',
      sPendingI2 === 'dialing' && sRingingI2 === 'ringing' && sConnectedI2 === 'connected' && !!c && voiceProp().activeCall === c && c.disconnects === 0
      && !devI.destroyed && !ev.some(e => e.startsWith('device:')) && !ev.includes('fetch:GET /api/twilio/token'),
      JSON.stringify({ sPendingI2, sRingingI2, sConnectedI2, ev }));
    m = mark('I2b');
    c?.emit('disconnect'); await settle(40);
    await waitFor(() => devI.destroyed && live().length === 1, 4000);
    await settle(80);
    ev = sinceMark(m);
    ok('I2b once the call ends, the waiting recovery runs exactly once (one new Device for the same account) and no separate refresh',
      countEv(ev, e => e === 'device:destroy:user_1') === 1 && countEv(ev, e => e.startsWith('device:new:user_1')) === 1
      && live().join() === 'user_1' && voiceProp().status === 'ready' && Fake.updateTokens === updI2, ev.join(','));

    // During the warm-up (no call yet) the Device may still be rebuilt, but the dialer stays "Connecting".
    await freshApp({ token: seed(1) });
    S.healthGate = new Promise(r => { releaseHealth = r; });
    const placingI3 = voiceProp().makeCall('5550000043');
    await settle(30);
    const oldI3 = liveDevice();
    voiceProp().retryVoiceSession();
    await waitFor(() => oldI3.destroyed && live().length === 1);
    await settle(40);
    const sWarmI3 = voiceProp().status;
    win.dispatchEvent(new Event('focus'));
    await settle(60);
    const sWarmI3b = voiceProp().status;
    releaseHealth(); S.healthGate = null;
    await placingI3;
    await settle(30);
    const cI3 = Fake.calls.at(-1);
    ok('I3 during the warm-up a rebuilt Device or a token refresh never shows the dialer as ready (it stays "Connecting"), and the call then goes out on the live Device',
      sWarmI3 === 'registering' && sWarmI3b === 'registering' && voiceProp().activeCall === cI3 && voiceProp().status === 'dialing' && liveDevice() !== oldI3,
      JSON.stringify({ sWarmI3, sWarmI3b, s: voiceProp().status }));
    cI3?.emit('disconnect');
    await settle(1700);

    // Double taps: one attempt at a time.
    await freshApp({ token: seed(1) });
    S.healthGate = new Promise(r => { releaseHealth = r; });
    m = mark('I4');
    const logI4 = logged.length;
    const tapsI4 = [voiceProp().makeCall('5550000044'), voiceProp().makeCall('5550000044')];   // same tick
    await settle(30);
    tapsI4.push(voiceProp().makeCall('5550000045'));       // later, still warming up
    await settle(10);
    const healthDuringI4 = countEv(sinceMark(m), e => e === 'fetch:GET /api/health');
    const settleI4 = holdConnect();
    releaseHealth(); S.healthGate = null;
    await waitFor(() => sinceMark(m).some(e => e.startsWith('device:connect:')));
    tapsI4.push(voiceProp().makeCall('5550000046'));       // while connect() is pending
    await settle(10);
    settleI4();
    await Promise.all(tapsI4);
    await settle(30);
    c = Fake.calls.at(-1);
    c?.emit('ringing'); await settle(10);
    await voiceProp().makeCall('5550000047');              // while it rings
    await settle(10);
    ev = sinceMark(m);
    ok('I4 a double tap during the warm-up, and taps while connect() is pending or the call rings, start no second attempt: one warm-up, one connect(), one call',
      healthDuringI4 === 1 && countEv(ev, e => e === 'fetch:GET /api/health') === 1 && countEv(ev, e => e.startsWith('device:connect:')) === 1
      && voiceProp().activeCall === c && voiceProp().remoteIdentity === '+15550000044' && ignoredSince(logI4) === 4,
      JSON.stringify({ healthDuringI4, ignored: ignoredSince(logI4), ev }));
    c?.emit('disconnect');
    await settle(40);
    m = mark('I4b');
    await voiceProp().makeCall('5550000048');
    await settle(30);
    const cI4b = Fake.calls.at(-1);
    ok('I4b once that call has ended, the next tap places a call', countEv(sinceMark(m), e => e.startsWith('device:connect:')) === 1 && voiceProp().activeCall === cI4b && cI4b !== c);
    await settle(1700);                                    // the previous call's "ended → ready" timer fires now
    ev = sinceMark(m);
    ok('I4c the previous call\'s "ended → ready" timer never resets the next call\'s dialer, and with nothing waiting no refresh or recovery runs after a call',
      voiceProp().status === 'dialing' && voiceProp().activeCall === cI4b && !ev.includes('fetch:GET /api/twilio/token') && !ev.some(e => e.startsWith('device:new')),
      JSON.stringify({ s: voiceProp().status, ev }));
    cI4b?.emit('disconnect');
    await settle(1700);
    const endsI4 = [];
    for (const end of ['cancel', 'error']) {
      await voiceProp().makeCall('5550000060');
      await settle(30);
      const cEnd = Fake.calls.at(-1);
      cEnd?.emit(end, ...(end === 'error' ? [Object.assign(new Error('Call failed'), { code: 31005 })] : []));
      await settle(20);
      m = mark(`I4d:${end}`);
      await voiceProp().makeCall('5550000061');
      await settle(30);
      endsI4.push({ end, placed: countEv(sinceMark(m), e => e.startsWith('device:connect:')) === 1 });
      Fake.calls.at(-1)?.emit('disconnect');
      await settle(1700);
    }
    ok('I4d a call that ends by cancel or by error releases the lock too: the next tap places a call',
      endsI4.every(x => x.placed), JSON.stringify(endsI4));

    // Every way an attempt fails releases the lock; a reasonless rejection settles.
    const failuresI5 = {
      declined: Object.assign(new Error('Call declined'), { code: 31002 }),
      micDenied: Object.assign(new Error('Permission denied'), { code: 31401, name: 'NotAllowedError' }),
      transport: transportErr(),
      noReason: Fake.REJECT_UNDEFINED,
      nullReason: Fake.REJECT_NULL,
    };
    const releasedI5 = [];
    for (const [name, outcome] of Object.entries(failuresI5)) {
      await freshApp({ token: seed(1) });
      p = await pendingCall('5550000049');
      let threwI5 = false;
      try { caught = await lateReject(p, outcome); } catch { threwI5 = true; caught = false; }
      if (name === 'transport') await waitFor(() => live().length === 1 && Fake.devices.at(-2)?.destroyed);
      await settle(30);
      v = voiceProp();
      const after = { s: v.status, e: v.error, mic: v.micBlocked };
      m = mark(`I5:${name}`);
      await voiceProp().makeCall('5550000050');
      await settle(30);
      const placed = countEv(sinceMark(m), e => e.startsWith('device:connect:')) === 1;
      releasedI5.push({ name, ok: !threwI5 && caught && placed, ...after });
      Fake.calls.at(-1)?.emit('disconnect');
      await settle(20);
    }
    ok('I5 every way a dial attempt fails (declined, mic denied, transport, no reason, null reason) releases the lock: the next tap places a call',
      releasedI5.every(x => x.ok), JSON.stringify(releasedI5.filter(x => !x.ok)));
    await freshApp({ token: seed(1) });
    devI = liveDevice();
    p = await pendingCall('5550000062');
    devI.emit('offline');                                  // a recovery now waits for the call
    m = mark('I5b');
    await lateReject(p, transportErr());                   // … and connect() fails on the dead transport
    await settle(1900);                                    // past the point where a waiting recovery would replay
    ev = sinceMark(m);
    ok('I5b a transport failure of the dial runs one recovery, which replaces the one that was waiting (not two)',
      countEv(ev, e => e.startsWith('device:new:user_1')) === 1 && countEv(ev, e => e === 'device:destroy:user_1') === 1 && live().join() === 'user_1', ev.join(','));
    const reasonless = releasedI5.filter(x => x.name === 'noReason' || x.name === 'nullReason');
    ok('I6 a current call whose connect() rejects with undefined or null settles: no throw, "Call did not connect", failed (not stuck on "dialing")',
      reasonless.length === 2 && reasonless.every(x => x.ok && x.s === 'failed' && x.e === ERR_NOT_CONNECTED), JSON.stringify(reasonless));

    // A stale attempt never releases the next sign-in's lock.
    await freshApp({ token: seed(1) });
    p = await pendingCall('5550000051');                   // account 1's attempt, connect() pending
    await clickLogout();
    await signInAs(2);
    S.healthGate = new Promise(r => { releaseHealth = r; });
    m = mark('I7');
    const placingI7 = voiceProp().makeCall('5550000052');  // account 2's attempt, warming up
    await settle(30);
    c = await lateResolve(p);                              // account 1's attempt settles late
    let logI7 = logged.length;
    const extraI7 = voiceProp().makeCall('5550000053');   // not awaited: if it were let through it would wait on the held warm-up
    await settle(10);
    const refusedI7 = ignoredSince(logI7) === 1;
    releaseHealth(); S.healthGate = null;
    await Promise.all([placingI7, extraI7]);
    await settle(30);
    ev = sinceMark(m);
    const cI7 = Fake.calls.at(-1);
    ok('I7 account 1\'s attempt settling after account 2 started one never releases account 2\'s lock: another tap is still refused, and account 2\'s call goes out once on its own Device',
      dropped(c) && refusedI7 && countEv(ev, e => e.startsWith('device:connect:')) === 1 && ev.includes('device:connect:user_2') && voiceProp().activeCall === cI7 && cI7 !== c,
      JSON.stringify({ refusedI7, ev }));
    cI7?.emit('disconnect');
    await settle(1700);
    await clickLogout();
    await freshApp({ token: seed(1) });
    await voiceProp().makeCall('5550000054');
    await settle(30);
    const cA7 = Fake.calls.at(-1);
    cA7?.emit('accept'); await settle(10);
    await clickLogout();
    await signInAs(2);
    S.healthGate = new Promise(r => { releaseHealth = r; });
    const placingI7b = voiceProp().makeCall('5550000055');
    await settle(30);
    cA7?.emit('disconnect'); cA7?.emit('error', new Error('late')); cA7?.emit('cancel');
    await settle(20);
    logI7 = logged.length;
    const extraI7b = voiceProp().makeCall('5550000056');
    await settle(10);
    const refusedI7b = ignoredSince(logI7) === 1;
    releaseHealth(); S.healthGate = null;
    await Promise.all([placingI7b, extraI7b]);
    await settle(30);
    ok('I7b account 1\'s connected call ending late (disconnect, error, cancel) never releases account 2\'s lock either',
      refusedI7b && voiceProp().activeCall === Fake.calls.at(-1) && Fake.calls.at(-1) !== cA7, JSON.stringify({ refusedI7b }));
    Fake.calls.at(-1)?.emit('disconnect');
    await settle(1700);
    await clickLogout();

    // A connect() that never settles is given up, so the lock and the waiting recovery are not held for good.
    await freshApp({ token: seed(1) });
    devI = liveDevice();
    const logI8 = logged.length;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === voiceHook.CONNECT_TIMEOUT_MS ? 80 : ms, ...a);
    try {
      p = await pendingCall('5550000057');
      devI.emit('offline');                                // recovery waits for the call
      await settle(250);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    v = voiceProp();
    const timedOutI8 = v.status === 'failed' && v.error === ERR_NOT_CONNECTED && v.activeCall === null && !devI.destroyed;
    await waitFor(() => devI.destroyed && live().length === 1, 4000);
    await settle(60);
    S.healthGate = new Promise(r => { releaseHealth = r; });
    m = mark('I8');
    const placingI8 = voiceProp().makeCall('5550000058');  // the next tap, warming up
    await settle(30);
    c = await lateResolve(p);                              // the given-up connect() settles after all
    const sAfterLateI8 = voiceProp().status;
    const logLateI8 = logged.length;
    const extraI8 = voiceProp().makeCall('5550000059');
    await settle(10);
    const stillLockedI8 = ignoredSince(logLateI8) === 1;
    releaseHealth(); S.healthGate = null;
    await Promise.all([placingI8, extraI8]);
    await settle(30);
    ev = sinceMark(m);
    ok('I8 a connect() that does not settle within CONNECT_TIMEOUT_MS is given up: "Call did not connect", the waiting recovery then runs, and the next tap places a call',
      timedOutI8 && live().join() === 'user_1' && countEv(ev, e => e.startsWith('device:connect:')) === 1 && voiceProp().activeCall === Fake.calls.at(-1),
      JSON.stringify({ timedOutI8, ev }));
    ok('I8b when that connect() settles after all, its call is hung up and unwired, and the next attempt\'s dialer and lock are left alone',
      dropped(c) && sAfterLateI8 === 'registering' && stillLockedI8 && logged.slice(logI8).some(l => l.includes('"reason":"connect_timeout"'))
      && logged.slice(logI8).some(l => l.includes('"reason":"attempt_ended"')), JSON.stringify({ sAfterLateI8, stillLockedI8, d: c?.disconnects, l: c?.listenerTotal() }));
    Fake.calls.at(-1)?.emit('disconnect');
    await settle(1700);

    // An unanswered call whose signalling drops ends without any further SDK event.
    await freshApp({ token: seed(1) });
    devI = liveDevice();
    await voiceProp().makeCall('5550000063');
    await settle(30);
    c = Fake.calls.at(-1);
    c?.emit('ringing'); await settle(10);
    devI.emit('unregistered');                             // a recovery waits for the call
    await settle(20);
    m = mark('I10');
    c?.dropTransport();
    await settle(40);
    v = voiceProp();
    const endedI10 = v.status === 'ended' && v.error === ERR_NOT_CONNECTED && v.activeCall === null;
    await waitFor(() => devI.destroyed && live().length === 1, 4000);
    await settle(60);
    await voiceProp().makeCall('5550000064');
    await settle(30);
    ev = sinceMark(m);
    ok('I10 an unanswered call whose signalling drops (the SDK emits only transportClose) ends: "Call did not connect", the lock is released, the waiting recovery runs, the next tap places a call',
      endedI10 && countEv(ev, e => e.startsWith('device:new:user_1')) === 1 && countEv(ev, e => e.startsWith('device:connect:')) === 1
      && voiceProp().activeCall === Fake.calls.at(-1), JSON.stringify({ endedI10, ev }));
    const cSilent = Fake.calls.at(-1);
    cSilent._status = 'closed';                            // closed with no event at all
    m = mark('I10b');
    await voiceProp().makeCall('5550000065');
    await settle(30);
    ok('I10b a call the SDK closed without any event no longer holds the lock: the next tap places a call',
      countEv(sinceMark(m), e => e.startsWith('device:connect:')) === 1 && voiceProp().activeCall === Fake.calls.at(-1) && Fake.calls.at(-1) !== cSilent);
    Fake.calls.at(-1)?.emit('disconnect');
    await settle(1700);
    await voiceProp().makeCall('5550000071');
    await settle(30);
    c = Fake.calls.at(-1);
    c?.emit('accept');
    await sleep(3100);
    m = mark('I10c');
    c?.disconnect();                                       // hung up: closed, 'disconnect'
    c?.emit('transportClose');                             // … and then the signalling goes too
    await settle(60);
    ev = sinceMark(m);
    ok('I10c a call that already ended is not ended a second time by a later transportClose (one call log, one note prompt)',
      countEv(ev, e => e === 'ensure-logged') === 1 && voiceProp().pendingPostCallNote?.phone === '+15550000071', ev.join(','));
    voiceProp().clearPostCallNote();
    await settle(1700);

    // A recovery that started during the warm-up resumes while the call rings.
    await freshApp({ token: seed(1) });
    devI = liveDevice();
    S.healthGate = new Promise(r => { releaseHealth = r; });
    const placingI11 = voiceProp().makeCall('5550000067');
    await settle(30);
    let releaseTokI11; S.tokenGate = new Promise(r => { releaseTokI11 = r; });
    devI.emit('unregistered');                             // allowed in the warm-up; its token request is held
    await settle(20);
    releaseHealth(); S.healthGate = null;
    await placingI11;
    await settle(20);
    c = Fake.calls.at(-1);
    c?.emit('ringing'); await settle(10);
    m = mark('I11');
    releaseTokI11(); S.tokenGate = null;
    await settle(80);
    ev = sinceMark(m);
    v = voiceProp();
    ok('I11 a recovery that started during the warm-up and resumes while the call rings waits instead of destroying the Device (and the call) under it',
      !devI.destroyed && !ev.some(e => e.startsWith('device:')) && v.status === 'ringing' && !!c && v.activeCall === c && c.status() !== 'closed', ev.join(','));
    m = mark('I11b');
    c?.emit('disconnect'); await settle(40);
    await waitFor(() => devI.destroyed && live().length === 1, 4000);
    await settle(60);
    ok('I11b … and runs once the call has ended', countEv(sinceMark(m), e => e.startsWith('device:new:user_1')) === 1 && voiceProp().status === 'ready');
    // Refresh / recovery that started in the warm-up and settle (fail, or succeed) while the call rings.
    const resumedI11 = [];
    for (const [kind, mode] of [['refresh', '500'], ['recover', '500'], ['refresh', 'ok']]) {
      await freshApp({ token: seed(1) });
      const devK = liveDevice();
      const updK = Fake.updateTokens;
      S.healthGate = new Promise(r => { releaseHealth = r; });
      const placingK = voiceProp().makeCall('5550000068');
      await settle(30);
      let releaseTokK; S.tokenGate = new Promise(r => { releaseTokK = r; });
      if (mode === '500') S.tokenMode = '500';
      if (kind === 'refresh') win.dispatchEvent(new Event('focus')); else devK.emit('unregistered');
      await settle(20);
      releaseHealth(); S.healthGate = null;
      await placingK;
      await settle(20);
      const cK = Fake.calls.at(-1);
      cK?.emit('ringing'); await settle(10);
      releaseTokK(); S.tokenGate = null;
      await settle(80);
      S.tokenMode = null;
      v = voiceProp();
      const during = { s: v.status, e: v.error, active: !!cK && v.activeCall === cK, upd: Fake.updateTokens - updK, destroyed: devK.destroyed };
      cK?.emit('disconnect'); await settle(40);
      await waitFor(() => (kind === 'refresh' ? Fake.updateTokens > updK : devK.destroyed && live().length === 1), 4000);
      await settle(60);
      const after = { upd: Fake.updateTokens - updK, rebuilt: devK.destroyed && live().length === 1, s: voiceProp().status };
      resumedI11.push({ kind, mode, during, after,
        ok: during.s === 'ringing' && during.e === null && during.active && during.upd === 0 && !during.destroyed
          && after.s === 'ready' && (kind === 'refresh' ? after.upd === 1 : after.rebuilt) });
    }
    ok('I11c a refresh or recovery that started in the warm-up and fails (or a refresh that succeeds) while the call rings changes nothing over the call — no failure, no Retry, no token update — and is tried again once the call has ended',
      resumedI11.every(x => x.ok), JSON.stringify(resumedI11.filter(x => !x.ok)));

    // A manual Retry while only dialing, with a recovery already waiting.
    await freshApp({ token: seed(1) });
    devI = liveDevice();
    p = await pendingCall('5550000069');
    devI.emit('offline');
    await settle(20);
    m = mark('I12');
    voiceProp().retryVoiceSession();
    await waitFor(() => devI.destroyed && live().length === 1);
    await settle(30);
    const sAfterRetryI12 = voiceProp().status;
    c = await lateResolve(p);
    await settle(1900);                                    // past the point where the waiting recovery would replay
    ev = sinceMark(m);
    v = voiceProp();
    ok('I12 a manual Retry while a call is only dialing rebuilds the Device once (replacing the waiting recovery), the dialer keeps "dialing" meanwhile, and the attempt is then reported as not connected',
      sAfterRetryI12 === 'dialing' && countEv(ev, e => e.startsWith('device:new:user_1')) === 1 && dropped(c) && v.status === 'failed' && v.error === ERR_NOT_CONNECTED,
      JSON.stringify({ sAfterRetryI12, s: v.status, ev }));

    // An invalid number fails before the lock is taken; a Device error never replaces a ringing call.
    await freshApp({ token: seed(1) });
    let threwI13 = false;
    try { await voiceProp().makeCall(null); } catch { threwI13 = true; }
    m = mark('I13');
    await voiceProp().makeCall('5550000070');
    await settle(30);
    ok('I13 an invalid number fails before the lock is taken: the next tap places a call', threwI13 && countEv(sinceMark(m), e => e.startsWith('device:connect:')) === 1);
    c = Fake.calls.at(-1);
    c?.emit('ringing'); await settle(10);
    liveDevice().emit('error', Object.assign(new Error('Device error'), { code: 31000 }));
    await settle(20);
    ok('I14 a Device error while an outbound call rings does not replace it with a failure (or a Retry over it)',
      voiceProp().status === 'ringing' && voiceProp().error === null && voiceProp().activeCall === c);
    c?.emit('disconnect');
    await settle(1700);
    if (R.root) unmount();
    ok('I9 no render errors, and no session token in any log line', R.errors.length === 0 && R.hookCountErrors === 0
      && !logged.some(l => /pl1_[A-Za-z0-9_-]{43}/.test(l)), String(R.errors[0] || ''));

    // ── U. Real LoginPage and real useCapacitorPush ─────────────────────────
    const units = require(OUT2);
    let retriedCalls = 0, dismissed = 0;
    mount(() => units.LoginPage({ onSuccess: () => {}, notice: { kind: 'logout_unconfirmed' }, onRetryLogout: async () => { retriedCalls++; await sleep(30); return true; }, onDismissNotice: () => { dismissed++; } }));
    await settle(20);
    const texts = walk(R.tree, n => typeof n === 'object' && n.props && typeof n.props.children === 'string').map(n => n.props.children).join(' | ');
    const status = find(n => n.props?.role === 'status');
    const retryBtn = status && walk(status, n => n.type === 'button')[0];
    ok('U1 the login page shows the unconfirmed sign-out notice in plain words, with a "Try again" button (no technical detail)',
      !!status && /couldn’t be confirmed/.test(JSON.stringify(status)) && !!retryBtn && !/pl1_|\/auth|Error/.test(JSON.stringify(status)), texts.slice(0, 200));
    // Fill the form so the submit button would otherwise be enabled.
    const inputs = () => walk(R.tree, n => n.type === 'input');
    for (const i of inputs()) i.props.onChange?.({ target: { value: i.props.type === 'password' ? 'a-password' : 'someone@example.test' } });
    await settle(5);
    const submitEnabledBefore = walk(R.tree, n => n.type === 'button' && n.props?.type === 'submit').some(b => b.props.disabled === false);
    const retryClick = find(n => n.props?.role === 'status') && walk(find(n => n.props?.role === 'status'), n => n.type === 'button')[0].props.onClick();
    await settle(5);
    const formButtons = walk(R.tree, n => n.type === 'button' && n.props?.type === 'submit');
    ok('U2 "Try again" calls the retry, and the (filled) sign-in form is disabled while it runs (no sign-in can race the retry)',
      retriedCalls === 1 && submitEnabledBefore && formButtons.length > 0 && formButtons.every(b => b.props.disabled === true)
      && inputs().every(i => i.props.disabled === true));
    await retryClick;
    unmount();
    // While a sign-in is in flight, "Try again" is locked too.
    let releaseLogin; S.loginGate = new Promise(r => { releaseLogin = r; });
    mount(() => units.LoginPage({ onSuccess: () => {}, notice: { kind: 'logout_unconfirmed' }, onRetryLogout: async () => { retriedCalls++; return true; } }));
    await settle(5);
    for (const i of walk(R.tree, n => n.type === 'input')) i.props.onChange?.({ target: { value: i.props.type === 'password' ? 'pw' : S.users[1].email } });
    await settle(5);
    const formEl = find(n => n.type === 'form');
    const submitting = formEl.props.onSubmit({ preventDefault() {} });
    await settle(10);
    const retryLocked = walk(find(n => n.props?.role === 'status'), n => n.type === 'button')[0];
    const callsBefore = retriedCalls;
    await retryLocked.props.onClick();
    ok('U7 while a sign-in is in flight, "Try again" is disabled and does nothing (no sign-out can race the sign-in)',
      retryLocked.props.disabled === true && retriedCalls === callsBefore);
    releaseLogin(); S.loginGate = null;
    await submitting;
    unmount();
    await api.logout();
    for (const kind of ['expired', 'disabled', 'offline', 'logout_unverifiable']) {
      mount(() => units.LoginPage({ onSuccess: () => {}, notice: { kind }, onDismissNotice: () => { dismissed++; } }));
      await settle(5);
      const st = find(n => n.props?.role === 'status');
      const x = st && walk(st, n => n.type === 'button')[0];
      x?.props.onClick();
      unmount();
    }
    ok('U3 every notice kind renders a message and can be dismissed', dismissed === 4);
    // useCapacitorPush on native Android: a token rotation while signed out is never sent.
    globalThis.__capacitorNative = true;
    let pushUser = null;
    mount(() => { units.useCapacitorPush({ userId: pushUser }); return null; });
    await settle(40);
    m = mark('U4');
    (FakePush.listeners.registration || []).forEach(fn => fn({ value: 'fcm-token-signed-out' }));
    await settle(30);
    const sentSignedOut = sinceMark(m).filter(e => e.startsWith('fetch:POST /api/push/fcm-subscribe')).length;
    store.set('plumbline_token', seed(1));
    pushUser = 1; schedule();
    await settle(40);
    m = mark('U4b');
    (FakePush.listeners.registration || []).forEach(fn => fn({ value: 'fcm-token-signed-in' }));
    await settle(30);
    const sentSignedIn = sinceMark(m).filter(e => e.startsWith('fetch:POST /api/push/fcm-subscribe')).length;
    unmount();
    globalThis.__capacitorNative = false;
    ok('U4 an FCM token rotation is sent only while someone is signed in (a signed-out device never re-attaches itself)',
      (FakePush.listeners.registration || []).length === 1 && sentSignedOut === 0 && sentSignedIn === 1, JSON.stringify({ sentSignedOut, sentSignedIn }));
    // GmailConnectionView: a temporary sign-in ended by closing the page is
    // recorded as a pending sign-out (its reply is never seen) …
    store.clear(); store.set('plOnboardingSeen', '1');
    store.set('plumbline_token', seed(1));
    store.set('plumbline_gmail_temp_signin', '1');
    mount(() => units.GmailConnectionView({ onDone: () => {} }));
    await settle(60);
    m = mark('U5');
    win.dispatchEvent(new Event('pagehide'));
    await settle(20);
    unmount();
    ok('U5 closing the Gmail screen with a temporary sign-in clears the token, records the sign-out as pending, and the unload request carries the token itself (ended even without a cookie)',
      !store.has('plumbline_token') && store.get('plumbline_logout_pending') === 'unload' && sinceMark(m).includes('logout:presented=1:ended=1'));
    // … and a later Gmail screen finishes it before treating the browser as signed in.
    m = mark('U6');
    mount(() => units.GmailConnectionView({ onDone: () => {} }));
    await settle(80);
    unmount();
    const evU6 = sinceMark(m);
    ok('U6 the Gmail screen finishes a pending sign-out first and never resumes that session (no /auth/me)',
      evU6.includes('fetch:POST /auth/logout') && !evU6.includes('fetch:GET /auth/me') && !store.has('plumbline_logout_pending'), evU6.join(','));
    // The app's next start after such an unload settles quietly (nothing left to present, nothing to warn about).
    store.set('plumbline_logout_pending', 'unload');
    await freshApp({ keepStore: true, reload: true });
    ok('U8 after an unload-time sign-out, the next app start finds nothing left to end and shows no false warning',
      !signedIn() && loginPage()?.props.notice === null && !store.has('plumbline_logout_pending'));
  } catch (err) {
    fail++;
    say(`FAIL  harness error: ${err.stack}`);
  } finally {
    try { if (R.root) unmount(); } catch {}
    for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`plumbline-fe-auth-${process.pid}`)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {} }
    say(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}
const tokRe = (t) => /^pl1_[A-Za-z0-9_-]{43}$/.test(t || '');
main();
