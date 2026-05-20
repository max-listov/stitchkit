import { createSweptMap } from './swept-map';

interface BucketEntry {
  tokens: number;
  lastRefill: number;
}

/** Token-bucket limit — at most `max` requests per `window` seconds. */
export interface RateLimitConfig {
  window: number;
  max: number;
}

/** Refill a bucket's tokens for the time elapsed since its last refill. */
function refillBucket(entry: BucketEntry, config: RateLimitConfig, now: number): void {
  const elapsed = (now - entry.lastRefill) / 1000;
  entry.tokens = Math.min(config.max, entry.tokens + (elapsed / config.window) * config.max);
  entry.lastRefill = now;
}

/**
 * Hard cap on tracked keys — without it an attacker rotating keys (e.g. a
 * spoofed IP) grows the bucket map unbounded between sweeps.
 */
const MAX_BUCKETS = 100_000;

/**
 * In-memory token-bucket rate limiter. `check(key, config)` consumes a token
 * and returns whether the request is allowed; `remaining(key, config)` reports
 * the count without consuming. Idle keys are swept on a 60-second timer and the
 * map is capped at `MAX_BUCKETS` (least-recently-used eviction); `destroy()`
 * stops the timer.
 *
 * `config` is per-call — reusing one `key` with two different configs lets
 * whichever call created the bucket fix its `max` / `window`. Key a bucket to
 * one config (one limiter per limit) if that matters.
 */
export function createRateLimiter() {
  const { store: buckets, destroy } = createSweptMap<BucketEntry>({
    intervalMs: 60_000,
    isExpired: (entry, now) => now - entry.lastRefill > 300_000,
  });

  return {
    destroy,
    check(key: string, config: RateLimitConfig): boolean {
      const now = Date.now();
      const entry = buckets.get(key);

      if (entry) {
        // Re-insert on access — a `Map` keeps insertion order, so deleting and
        // re-adding moves this key to the newest end. The cap below then evicts
        // the genuinely least-recently-used key, not the oldest by birth.
        buckets.delete(key);
        buckets.set(key, entry);
        refillBucket(entry, config, now);
        if (entry.tokens < 1) return false;
        entry.tokens -= 1;
        return true;
      }

      // Evict the least-recently-used bucket once the cap is hit — bounds
      // memory against a key-rotation flood between sweeps.
      if (buckets.size >= MAX_BUCKETS) {
        const lru = buckets.keys().next().value;
        if (lru !== undefined) buckets.delete(lru);
      }
      const fresh: BucketEntry = { tokens: config.max, lastRefill: now };
      buckets.set(key, fresh);
      if (fresh.tokens < 1) return false;
      fresh.tokens -= 1;
      return true;
    },

    remaining(key: string, config: RateLimitConfig): number {
      const entry = buckets.get(key);
      if (!entry) return config.max;
      refillBucket(entry, config, Date.now());
      return Math.floor(entry.tokens);
    },
  };
}
