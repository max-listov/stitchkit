/**
 * A pool of reserved sequence numbers a tab can spend **synchronously**.
 *
 * The page-leave event is materialised inside `pagehide`, where awaiting a
 * storage transaction means the document dies first. So the tab keeps a block
 * reserved ahead of time and refills it below a low-water mark; uniqueness
 * across tabs comes from the atomic reservation, not from the moment of use.
 *
 * When the reservation source fails (no IndexedDB), the pool switches to a
 * per-tab fallback: a random base plus a counter — the honest minimum, and the
 * event then goes straight to the network without a queue.
 */
export interface SequenceReserveOptions {
  /** Numbers reserved per refill. Default 16. */
  blockSize?: number;
  /** Refill when fewer than this remain. Default 4. */
  lowWater?: number;
  /** Called once when the source fails and the fallback takes over. */
  onUnavailable?: (error: unknown) => void;
  /** Random base for the fallback; injectable for tests. */
  fallbackBase?: () => number;
}

export interface SequenceReserve {
  /** The next number, or `null` when the pool is empty and a refill is pending. */
  take(): number | null;
  /** Reserve a block now; resolves when the pool is refilled (or the fallback engaged). */
  refill(): Promise<void>;
  /** Whether numbers still come from the shared source. */
  shared(): boolean;
  /** Forget the fallback and the pool — the shared source is back. */
  reset(): void;
}

export function createSequenceReserve(
  reserve: (count: number) => Promise<number[]>,
  options: SequenceReserveOptions = {},
): SequenceReserve {
  const blockSize = options.blockSize ?? 16;
  const lowWater = options.lowWater ?? 4;
  const pool: number[] = [];
  let pending: Promise<void> | null = null;
  let fallback: number | null = null;

  const pushFallbackBlock = (): void => {
    for (let i = 0; i < blockSize; i += 1) {
      fallback = (fallback ?? 0) + 1;
      pool.push(fallback);
    }
  };

  const refill = (): Promise<void> => {
    if (pending) return pending;
    if (fallback !== null) {
      pushFallbackBlock();
      return Promise.resolve();
    }
    pending = reserve(blockSize)
      .then((reserved) => {
        pool.push(...reserved);
      })
      .catch((error: unknown) => {
        fallback =
          (options.fallbackBase ?? (() => Math.floor(Math.random() * 1_000_000)))() *
          1_000_000;
        options.onUnavailable?.(error);
        pushFallbackBlock();
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    take() {
      const next = pool.shift() ?? null;
      if (pool.length < lowWater) void refill();
      return next;
    },
    refill,
    shared: () => fallback === null,
    reset() {
      fallback = null;
      pool.length = 0;
    },
  };
}
