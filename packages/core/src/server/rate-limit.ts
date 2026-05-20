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
 * In-memory token-bucket rate limiter. `check(key, config)` consumes a token
 * and returns whether the request is allowed; `remaining(key, config)` reports
 * the count without consuming. Idle keys are swept on a 60-second timer;
 * `destroy()` stops it.
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
      let entry = buckets.get(key);

      if (!entry) {
        entry = { tokens: config.max, lastRefill: now };
        buckets.set(key, entry);
      }

      refillBucket(entry, config, now);

      if (entry.tokens < 1) return false;

      entry.tokens -= 1;
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
