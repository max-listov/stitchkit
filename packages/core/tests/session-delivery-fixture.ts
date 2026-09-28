import type { ManagedResourceContext } from '../src/application/resource';
import type { StateStore } from '../src/application/state-store';
import { createMutationQueue } from '../src/internal/mutation-queue';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await Bun.sleep(1);
  }
}
export function resourceContext(health: string[] = []): ManagedResourceContext {
  return {
    applicationId: 'test',
    signal: new AbortController().signal,
    admission: {
      acquire: () => null,
      acquireWhenAccepting: async () => {
        throw new Error('unused');
      },
    },
    now: Date.now,
    reportHealth: (value) => {
      health.push(value);
    },
    use: () => {
      throw new Error('unused');
    },
  };
}
export function memoryState<T>(): StateStore<T> {
  let state: T | null = null;
  const serialize = createMutationQueue();
  return {
    read: async () => state,
    update: (transition) =>
      serialize(async () => {
        const result = await transition(state);
        state = result.state;
        return result.result;
      }),
  };
}
