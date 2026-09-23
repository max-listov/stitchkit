import { type BackoffPolicy, createBackoff } from '../internal/backoff';

export interface ResumableAttempt {
  /** 1 for the first re-open after a failure, growing until a delivery resets it. */
  readonly number: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface ResumableIteratorConfig<T, CURSOR> {
  /** Open the stream, from the last cursor a delivered item advanced to. */
  open(cursor: CURSOR | undefined): AsyncIterable<T> | Promise<AsyncIterable<T>>;
  /** The cursor that would resume after this item. The framework never reads inside it. */
  advance(item: T, cursor: CURSOR | undefined): CURSOR;
  /** An item that ends the stream for good instead of triggering a re-open. */
  isTerminal?(item: T): boolean;
  retry?: BackoffPolicy;
  signal?: AbortSignal;
  /** Called before each wait. A reconnect loop nobody can see is the shape of this defect. */
  onAttempt?(attempt: ResumableAttempt): void;
  /** Deterministic jitter for tests; defaults to `Math.random`. */
  random?(): number;
}

const DEFAULT_RETRY: BackoffPolicy = { minDelayMs: 100, maxDelayMs: 30_000, jitter: 0.5 };

class ResumableAbortError extends Error {
  constructor() {
    super('Resumable iterator was aborted');
    this.name = 'ResumableAbortError';
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new ResumableAbortError());
    }
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new ResumableAbortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Re-open a long-lived stream from the last delivered position.
 *
 * The caller owns every domain decision: `open` knows the transport, `advance` knows what a
 * cursor means and `isTerminal` knows which item ends the stream. What this owns is the part
 * that is the same everywhere and wrong in most hand-written copies — retrying with a bounded,
 * jittered delay, resuming rather than restarting, resetting the backoff once the stream
 * delivers again, and stopping promptly when the caller aborts.
 *
 * A failure while opening and a failure mid-stream are one case: both re-open from the cursor
 * the last delivered item produced.
 */
export async function* resumableIterator<T, CURSOR>(
  config: ResumableIteratorConfig<T, CURSOR>,
): AsyncGenerator<T, void, undefined> {
  const backoff = createBackoff(config.retry ?? DEFAULT_RETRY, config.random);
  let cursor: CURSOR | undefined;
  let attempt = 0;

  for (;;) {
    if (config.signal?.aborted) return;
    try {
      const source = await config.open(cursor);
      for await (const item of source) {
        if (config.signal?.aborted) return;
        // A delivery is the only proof the stream works, so it is what clears the backoff.
        attempt = 0;
        backoff.reset();
        cursor = config.advance(item, cursor);
        yield item;
        if (config.isTerminal?.(item)) return;
      }
      // A source that ends without a terminal item is a dropped connection, not completion.
      // Saying otherwise here is how a resumable consumer silently stops resuming.
      throw new Error('Resumable source ended without a terminal item');
    } catch (error) {
      if (config.signal?.aborted || error instanceof ResumableAbortError) return;
      attempt += 1;
      const delayMs = backoff.next();
      config.onAttempt?.({ number: attempt, delayMs, error });
      try {
        await sleep(delayMs, config.signal);
      } catch {
        return;
      }
    }
  }
}
