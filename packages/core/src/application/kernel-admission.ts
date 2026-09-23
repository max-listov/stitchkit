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
