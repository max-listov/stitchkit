import { createSweptMap } from './swept-map';

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

/**
 * In-memory key/value cache with a per-entry TTL. Expired entries are swept on
 * a 30-second timer; `destroy()` stops it. For response `Cache-Control`
 * headers use `cacheHeaders()` instead.
 */
export function createCache() {
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
      store.set(key, { data, expiresAt: Date.now() + maxAgeSeconds * 1000 });
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
