const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;

async function settleCleanup(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Provider stream cleanup exceeded ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Consume the one provider stream owned by a runtime attempt.
 *
 * AI SDK result streams are tee branches so cancelling only the branch being
 * iterated does not necessarily stop the retained provider branch. Abort the
 * attempt first, then close the iterator within a finite budget. Cleanup is a
 * secondary failure: callers keep the operation that made them leave the loop
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
      const cleanup = iterator.return?.();
      if (cleanup) {
        try {
          await settleCleanup(cleanup, input.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
        } catch (error) {
          input.onCleanupFailure(error);
        }
      }
    }
  }
}
