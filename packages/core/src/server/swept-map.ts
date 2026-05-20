/**
 * A string-keyed `Map` with a background sweep that evicts expired entries.
 * The shared scaffold behind `createCache` and `createRateLimiter` — they
 * differ only in the expiry predicate and the sweep interval.
 */

/** Config for `createSweptMap`. */
export interface SweptMapOptions<V> {
  /** Sweep interval, in milliseconds. */
  intervalMs: number;
  /** `true` for an entry that should be evicted — `now` is `Date.now()`. */
  isExpired: (value: V, now: number) => boolean;
}

/** A swept map — its backing store plus a teardown. */
export interface SweptMap<V> {
  /** The backing map — read and written directly by the owner. */
  store: Map<string, V>;
  /** Stop the sweep timer and clear the map. */
  destroy: () => void;
}

/** Build a `Map` that evicts expired entries on a background timer. */
export function createSweptMap<V>(options: SweptMapOptions<V>): SweptMap<V> {
  const store = new Map<string, V>();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of store) {
      if (options.isExpired(value, now)) store.delete(key);
    }
  }, options.intervalMs);
  // A sweep timer must not by itself keep the process alive.
  timer.unref();

  return {
    store,
    destroy() {
      clearInterval(timer);
      store.clear();
    },
  };
}
