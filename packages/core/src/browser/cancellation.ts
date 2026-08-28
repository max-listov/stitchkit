type CancellationCause = 'caller' | 'timeout';

/** Internal transport cancellation with the first abort cause preserved. */
export class RequestCancellationError extends Error {
  constructor(public readonly cause: CancellationCause) {
    super(cause === 'caller' ? 'Request was aborted' : 'Request timed out');
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
  let cause: CancellationCause | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = (): void => {
    if (cause) return;
    cause = 'caller';
  };
  if (caller?.aborted) abortFromCaller();
  else caller?.addEventListener('abort', abortFromCaller, { once: true });
  if (timeoutMs !== undefined && timeoutController) {
    timer = setTimeout(() => {
      if (cause) return;
      cause = 'timeout';
      timeoutController.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  return {
    signal,
    async run(operation) {
      try {
        if (cause === 'caller') throw cancellationError(cause);
        return await operation(signal);
      } catch (error) {
        if (cause) throw cancellationError(cause);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        caller?.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

function cancellationError(cause: CancellationCause): RequestCancellationError {
  return new RequestCancellationError(cause);
}
