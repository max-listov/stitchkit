import {
  type DurabilityClock,
  ParkAbortedError,
  type StepDurabilityLedger,
} from './durability-contract';
export const systemClock: DurabilityClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, Math.min(delayMs, 2_147_483_647));
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * In-flight steps of one process, keyed by the full durable key and removed as
 * soon as they settle.
 *
 * It is module-level rather than per-object so two durability objects built over
 * the same store in one process cannot both start an effectful body. It cannot
 * span processes: a second process is fenced by the run lease the runtime
 * already holds, not by this map, and that is the boundary this local slice
 * draws.
 */
export interface InFlightDurability {
  steps: Map<string, Promise<unknown>>;
  parks: Map<string, Promise<unknown>>;
  waiters: Map<string, Set<() => void>>;
}
export const stores = new WeakMap<StepDurabilityLedger, InFlightDurability>();

export function notifyWaiters(parkWaiters: InFlightDurability['waiters'], key: string): void {
  const waiters = parkWaiters.get(key);
  if (!waiters) return;
  for (const wake of [...waiters]) wake();
}

/** Resolve `'elapsed'` when the timer fires, `'aborted'` if the signal fires first. */
function waitForTimer(
  clock: DurabilityClock,
  delayMs: number,
  signal?: AbortSignal,
): Promise<'elapsed' | 'aborted'> {
  return new Promise((resolve) => {
    let timer: { cancel(): void } | undefined;
    let settled = false;
    const finish = (outcome: 'elapsed' | 'aborted') => {
      if (settled) return;
      settled = true;
      timer?.cancel();
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish('aborted');
    timer = clock.schedule(() => finish('elapsed'), delayMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export async function waitForDeadline(
  clock: DurabilityClock,
  deadline: number,
  park: string,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new ParkAbortedError(park);
    const remaining = deadline - clock.now();
    if (remaining <= 0) return;
    const outcome = await waitForTimer(clock, remaining, signal);
    if (outcome === 'aborted') throw new ParkAbortedError(park);
  }
}

interface ParkWaiter {
  /** `'woke'` when a delivery notifies this park, `'aborted'` when the signal fires. */
  readonly outcome: Promise<'woke' | 'aborted'>;
  /** Remove this waiter from the registry; idempotent. */
  cancel(): void;
}

export function createParkWaiter(
  parkWaiters: InFlightDurability['waiters'],
  key: string,
  signal?: AbortSignal,
): ParkWaiter {
  const waiters = parkWaiters.get(key) ?? new Set<() => void>();
  parkWaiters.set(key, waiters);
  let settle!: (outcome: 'woke' | 'aborted') => void;
  const outcome = new Promise<'woke' | 'aborted'>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const cleanup = () => {
    waiters.delete(onWake);
    if (waiters.size === 0) parkWaiters.delete(key);
    signal?.removeEventListener('abort', onAbort);
  };
  const finish = (result: 'woke' | 'aborted') => {
    if (settled) return;
    settled = true;
    cleanup();
    settle(result);
  };
  const onWake = () => finish('woke');
  const onAbort = () => finish('aborted');
  waiters.add(onWake);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return { outcome, cancel: cleanup };
}
