import { withDeadline } from '../internal/deadline';

const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;

async function settleCleanup(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  const outcome = await withDeadline(operation, timeoutMs);
  if (!outcome.settled) {
    void operation.catch(() => undefined);
    throw new Error(`Provider stream cleanup exceeded ${timeoutMs} ms`);
  }
}

/**
 * Consume the one provider stream owned by a runtime attempt.
 *
 * Provider stream adapters may retain an underlying transport or tee branch, so
 * cancelling only the iterated branch does not necessarily stop upstream reads.
 * Abort the attempt first, then close the iterator within a finite budget. Cleanup
 * is a secondary failure: callers keep the operation that made them leave the loop
 * as the primary cause.
 */
export async function* ownedProviderStream<T>(input: {
  stream: AsyncIterable<T>;
  abort: () => void;
  onCleanupFailure: (error: unknown) => void;
  cleanupTimeoutMs?: number;
}): AsyncGenerator<T, void, undefined> {
  const iterator = input.stream[Symbol.asyncIterator]();
  let completed = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) {
      input.abort();
      try {
        const cleanup = iterator.return?.();
        if (cleanup) {
          await settleCleanup(cleanup, input.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
        }
      } catch (error) {
        input.onCleanupFailure(error);
      }
    }
  }
}
