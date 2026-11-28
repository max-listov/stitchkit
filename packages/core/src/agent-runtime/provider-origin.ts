/**
 * Which errors came out of the model driver call itself.
 *
 * The terminal reason is decided by origin, never by elimination: anything
 * thrown inside `driver.stream()` or while iterating `stream.parts` is marked
 * here so the runtime classifies it as `provider_failure` (unless the runtime
 * itself owns the failure, e.g. `AgentContextOverflowError`), while store
 * conflicts, application callbacks and approval refusals stay unmarked. → ADR 0336.
 */
const providerOrigin = new WeakSet<object>();

/** Records that this error came out of the provider call itself. */
export function markProviderOrigin<T>(error: T): T {
  if (typeof error === 'object' && error !== null) providerOrigin.add(error);
  return error;
}

/** Whether this error came out of the provider call itself. */
export function hasProviderOrigin(error: unknown): boolean {
  return typeof error === 'object' && error !== null && providerOrigin.has(error);
}

/**
 * Wrap a driver's part stream so every rejected read is marked provider-origin
 * while downstream runtime work on yielded parts remains unmarked.
 */
export function markProviderParts<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        async next() {
          try {
            return await iterator.next();
          } catch (error) {
            throw markProviderOrigin(error);
          }
        },
        async return(value?: unknown) {
          if (!iterator.return) return { done: true as const, value: undefined };
          return iterator.return(value);
        },
        async throw(error?: unknown) {
          if (!iterator.throw) throw error;
          return iterator.throw(error);
        },
      };
    },
  };
}
