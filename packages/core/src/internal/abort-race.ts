/**
 * Releases an await on cancellation without assuming a callback cooperates with its signal.
 *
 * When the signal wins and the operation settles later, a fulfilled value is handed to
 * `disposeLate` so an owner can release what it would otherwise leak (a stream, a
 * handle); a late rejection is swallowed because the caller already has the reason.
 */
export function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  const dispose = (value: T): void => {
    try {
      disposeLate?.(value);
    } catch {
      // A disposer failure must not replace the cancellation the caller is handling.
    }
  };
  if (signal.aborted) {
    operation.then(dispose, () => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let released = false;
    const abort = () => {
      released = true;
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (released) dispose(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        if (!released) reject(error);
      },
    );
  });
}
