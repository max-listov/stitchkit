import { abortError } from '../internal/abort-error';
import { linkAbortSignals } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';
export type RequestCancellationOrigin = 'caller' | 'timeout';

/** Internal transport cancellation with its first origin and transport failure preserved. */
export class RequestCancellationError extends Error {
  constructor(
    public readonly origin: RequestCancellationOrigin,
    cause?: unknown,
  ) {
    super(
      origin === 'caller' ? 'Request was aborted' : 'Request timed out',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'RequestCancellationError';
  }
}

/**
 * Whether the response body is read inside `run` (`'read'`) or handed to the caller to read after
 * it (`'handed-out'`): a handed-out body keeps the caller link until the caller or its source aborts.
 */
export type RequestBodyLifetime = 'read' | 'handed-out';

export interface RequestCancellation {
  /**
   * Run the request with a signal that aborts on the caller or the timeout. The timer stops when
   * `operation` settles, and so does the caller link unless the body is handed out.
   */
  run<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    body?: RequestBodyLifetime,
  ): Promise<T>;
}

/** Compose caller cancellation and timeout while preserving the first cause. */
export function createRequestCancellation(
  caller: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RequestCancellation {
  // A per-request timeout is taken here, before the request is sent.
  assertTimerMs('HTTP request timeout', timeoutMs);
  if (!caller && timeoutMs === undefined) {
    return { run: (operation) => operation() };
  }
  const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
  const link =
    caller && timeoutController
      ? linkAbortSignals(caller, timeoutController.signal)
      : undefined;
  const signal = link?.signal ?? caller ?? timeoutController?.signal;
  let origin: RequestCancellationOrigin | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = (): void => {
    if (origin) return;
    origin = 'caller';
  };
  if (caller?.aborted) abortFromCaller();
  else caller?.addEventListener('abort', abortFromCaller, { once: true });
  if (timeoutMs !== undefined && timeoutController) {
    timer = setTimeout(() => {
      if (origin) return;
      origin = 'timeout';
      timeoutController.abort(abortError('Request timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  return {
    async run(operation, body = 'read') {
      try {
        if (origin === 'caller') throw cancellationError(origin);
        const value = await operation(signal);
        if (body === 'read') link?.release();
        return value;
      } catch (error) {
        link?.release();
        if (error instanceof RequestCancellationError) throw error;
        if (origin) throw cancellationError(origin, error);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        caller?.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

function cancellationError(
  origin: RequestCancellationOrigin,
  cause?: unknown,
): RequestCancellationError {
  return new RequestCancellationError(origin, cause);
}
