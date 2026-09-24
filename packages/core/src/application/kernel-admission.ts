import { ApplicationAdmissionError, type ApplicationOperationLease } from './kernel-contract';
import { isReady, type KernelState, publish } from './kernel-state';

/** Admit one operation, or refuse it while the application is not accepting. */
export function acquire(state: KernelState): ApplicationOperationLease | null {
  if (!state.accepting || !isReady(state)) return null;
  state.accepted += 1;
  state.pending += 1;
  publish(state);
  let released = false;
  return {
    get released() {
      return released;
    },
    release() {
      if (released) return;
      released = true;
      state.pending -= 1;
      state.completed += 1;
      if (state.pending === 0) {
        for (const waiter of state.pendingWaiters) waiter();
        state.pendingWaiters.clear();
      }
      publish(state);
    },
  };
}

export async function run<T>(state: KernelState, work: () => T | Promise<T>): Promise<T> {
  const lease = acquire(state);
  if (!lease) throw new ApplicationAdmissionError();
  try {
    return await work();
  } finally {
    lease.release();
  }
}

/** Resolves once every admitted operation has released its lease. */
export function waitForPending(state: KernelState): Promise<void> {
  if (state.pending === 0) return Promise.resolve();
  return new Promise((resolve) => state.pendingWaiters.add(resolve));
}

/**
 * Wait until the application admits, then admit one operation.
 *
 * For the resource that brings work in rather than the caller that is handed
 * it: a poller asking Telegram for the next batch has nothing to refuse — the
 * right move while the application is starting or degraded is to not ask yet.
 * Rejects with the signal's reason once it aborts, and with
 * `ApplicationAdmissionError` once the application can no longer admit at all,
 * so a waiter never outlives the lifetime it was waiting on.
 */
export function acquireWhenAccepting(
  state: KernelState,
  signal: AbortSignal,
): Promise<ApplicationOperationLease> {
  return new Promise((resolve, reject) => {
    let scheduled = false;
    let settled = false;
    const finish = (): void => {
      settled = true;
      state.listeners.delete(onChange);
      signal.removeEventListener('abort', attempt);
    };
    function attempt(): boolean {
      // A retry queued before the promise settled must not admit a second
      // operation that nobody holds and nobody will release.
      if (settled) return true;
      if (signal.aborted) {
        finish();
        reject(signal.reason);
        return true;
      }
      if (
        state.shutdownRequested ||
        state.lifecycle === 'failed' ||
        state.lifecycle === 'stopped'
      ) {
        finish();
        reject(new ApplicationAdmissionError());
        return true;
      }
      const lease = acquire(state);
      if (!lease) return false;
      finish();
      resolve(lease);
      return true;
    }
    // A snapshot listener runs inside `publish`; admitting from there would
    // publish again mid-notification. The next turn sees the settled state.
    function onChange(): void {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        attempt();
      });
    }
    if (attempt()) return;
    state.listeners.add(onChange);
    signal.addEventListener('abort', attempt, { once: true });
  });
}
