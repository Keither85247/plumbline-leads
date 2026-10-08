'use strict';
/**
 * Small in-memory rate limiter (no dependencies, no external service).
 *
 * Sliding-window approximation with two fixed buckets per key:
 *   estimate = prev * (1 - elapsedInWindow / windowMs) + curr
 * O(1) memory per key; keys are kept in Map insertion order (LRU) and capped
 * at maxKeys; a shared timer sweeps idle keys every minute.
 *
 * Deployment notes: counters live in this Node process only. On Render's single
 * instance (the persistent disk rules out horizontal scaling) the limits are
 * global. A deploy or restart resets every counter (also an emergency unlock).
 * If the service is ever scaled to N instances, the effective limits become
 * N× and the counters must move to a shared store.
 */

const registry = new Set();

function createLimiter({ name, windowMs, max, maxKeys = 20000, now = () => Date.now() }) {
  const buckets = new Map();

  function roll(key, t) {
    let b = buckets.get(key);
    const start = t - (t % windowMs);
    if (!b) {
      b = { start, curr: 0, prev: 0 };
    } else if (b.start !== start) {
      b.prev = (start - b.start === windowMs) ? b.curr : 0;
      b.curr = 0;
      b.start = start;
    }
    // Re-insert so Map order is least-recently-used first.
    buckets.delete(key);
    buckets.set(key, b);
    if (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
    return b;
  }

  function estimate(b, t) {
    return b.prev * (1 - (t - b.start) / windowMs) + b.curr;
  }

  function retryAfterSec(b, t) {
    return Math.max(1, Math.ceil((b.start + windowMs - t) / 1000));
  }

  const limiter = {
    name,
    /** Seconds to wait if the key is already at/over the limit, else 0. Does not count. */
    check(key) {
      if (key == null) return 0;
      const t = now();
      const b = roll(String(key), t);
      return estimate(b, t) >= max ? retryAfterSec(b, t) : 0;
    },
    /** Count one event; returns seconds to wait if this event exceeds the limit, else 0. */
    hit(key) {
      if (key == null) return 0;
      const t = now();
      const b = roll(String(key), t);
      b.curr += 1;
      return estimate(b, t) > max ? retryAfterSec(b, t) : 0;
    },
    /** Forget a key (e.g. after a successful login). */
    reset(key) {
      if (key != null) buckets.delete(String(key));
    },
    sweep() {
      const t = now();
      for (const [k, b] of buckets) if (t - b.start >= 2 * windowMs) buckets.delete(k);
    },
    size() { return buckets.size; },
    clear() { buckets.clear(); },
  };
  registry.add(limiter);
  return limiter;
}

/**
 * Bounded "recently seen" set with a TTL (e.g. IPs that signed in to an account
 * successfully). Same restart/scaling caveats as the limiters.
 */
function createRecentSet({ ttlMs, maxKeys = 20000, now = () => Date.now() }) {
  const seen = new Map();
  const set = {
    add(key) {
      if (key == null) return;
      seen.delete(String(key));
      seen.set(String(key), now());
      if (seen.size > maxKeys) seen.delete(seen.keys().next().value);
    },
    has(key) {
      if (key == null) return false;
      const t = seen.get(String(key));
      if (t == null) return false;
      if (now() - t > ttlMs) { seen.delete(String(key)); return false; }
      return true;
    },
    sweep() { const t = now(); for (const [k, v] of seen) if (t - v > ttlMs) seen.delete(k); },
    size() { return seen.size; },
    clear() { seen.clear(); },
  };
  registry.add(set);
  return set;
}

const sweeper = setInterval(() => { for (const l of registry) l.sweep(); }, 60_000);
sweeper.unref();

module.exports = { createLimiter, createRecentSet };
