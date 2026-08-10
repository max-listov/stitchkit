import { createSweptMap } from './swept-map';

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

export interface CacheOptions {
  /** Maximum retained entries. Oldest entries are evicted first. Default 1,000. */
  maxEntries?: number;
}

/**
 * In-memory key/value cache with a per-entry TTL. Expired entries are swept on
 * a 30-second timer; `destroy()` stops it. For response `Cache-Control`
 * headers use `cacheHeaders()` instead.
 */
export function createCache(options: CacheOptions = {}) {
  const maxEntries = options.maxEntries ?? 1_000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('cache.maxEntries must be a positive integer');
  }
  const { store, destroy } = createSweptMap<CacheEntry>({
    intervalMs: 30_000,
    isExpired: (entry, now) => entry.expiresAt < now,
  });

  return {
    destroy,
    get(key: string): unknown | null {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.data;
    },

    set(key: string, data: unknown, maxAgeSeconds: number) {
      if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
        throw new Error('cache maxAgeSeconds must be a non-negative finite number');
      }
      store.delete(key);
      store.set(key, { data, expiresAt: Date.now() + maxAgeSeconds * 1000 });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },

    invalidate(prefix: string) {
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    },

    clear() {
      store.clear();
    },
  };
}

/** Build a `Cache-Control` header capping freshness at `maxAge` seconds. */
export function cacheHeaders(
  maxAge: number,
  scope: 'public' | 'private' = 'public',
): Record<string, string> {
  return {
    'Cache-Control': `${scope}, max-age=${maxAge}`,
  };
}
