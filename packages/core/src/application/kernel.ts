import { acquire, run } from './kernel-admission';
import type { ApplicationConfig, ApplicationHandle } from './kernel-contract';
import { restart } from './kernel-restart';
import { shutdown } from './kernel-shutdown';
import { start } from './kernel-start';
import { createKernelState, snapshot } from './kernel-state';

/**
 * Compose process-local resources into one deterministic application lifetime.
 *
 * The phases of that lifetime each live in their own module and share one
 * explicit `KernelState`: registration and the resource graph
 * (`kernel-state`), start and activation with the rollback of a failed start
 * (`kernel-start`, `kernel-rollback`), operation admission
 * (`kernel-admission`), subtree restart (`kernel-restart`) and the bounded
 * shutdown (`kernel-shutdown`). This function only wires them to the handle.
 */
export function createApplication(config: ApplicationConfig): ApplicationHandle {
  const state = createKernelState(config);
  return {
    id: state.id,
    admission: {
      acquire: () => acquire(state),
      run: <T>(work: () => T | Promise<T>) => run(state, work),
    },
    start: () => start(state),
    getSnapshot: () => snapshot(state),
    subscribe(listener) {
      state.listeners.add(listener);
      listener(snapshot(state));
      return () => state.listeners.delete(listener);
    },
    shutdown: (options) => shutdown(state, options),
    restart: (input) => restart(state, input),
  };
}
