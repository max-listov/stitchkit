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

export interface RequestCancellation {
  signal?: AbortSignal;
  run<T>(operation: (signal?: AbortSignal) => Promise<T>): Promise<T>;
}

/** Compose caller cancellation and timeout while preserving the first cause. */
export function createRequestCancellation(
  caller: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RequestCancellation {
  if (!caller && timeoutMs === undefined) {
    return { signal: undefined, run: (operation) => operation() };
  }
  const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
  const signal =
    caller && timeoutController
      ? AbortSignal.any([caller, timeoutController.signal])
      : (caller ?? timeoutController?.signal);
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
      timeoutController.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  return {
    signal,
    async run(operation) {
      try {
        if (origin === 'caller') throw cancellationError(origin);
        return await operation(signal);
      } catch (error) {
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
