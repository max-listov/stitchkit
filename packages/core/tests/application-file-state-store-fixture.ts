import type { StateStore, StateStoreUpdateContext } from '../src/application/state-store';

/** A real serialized in-memory transaction for application adapter tests. */
export function serialStateStore<TState>(initial: TState | null = null): StateStore<TState> {
  let state = initial;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    read: async () => state,
    update(transition) {
      const result = tail.then(async () => {
        let active = true;
        const context: StateStoreUpdateContext = {
          async assertHeld() {
            if (!active) throw new Error('Memory state transaction is no longer active');
          },
        };
        try {
          const next = await transition(state, context);
          await context.assertHeld();
          state = next.state;
          return next.result;
        } finally {
          active = false;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
