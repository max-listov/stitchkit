/** The signal's reason, or the `AbortError` a signal aborted without one stands for. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/**
 * `pending`, or the signal's reason as soon as it aborts. Each call owns its listener and removes
 * it when `pending` settles: one promise shared by every call would retain each result for as long
 * as the signal lives. `pending` itself is not cancelled, only no longer waited for.
 */
export function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    if (signal.aborted) {
      pending.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
