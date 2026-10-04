/** A deadline cancels waits and blocks late promotion; trusted callbacks own their external effects. */
export function waitForPublication<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          if (value instanceof ReadableStream && !value.locked)
            void value.cancel(signal.reason).catch(() => undefined);
          reject(signal.reason);
        } else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export async function withPublicationDeadline<T>(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(caller?.reason);
  caller?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`CLI publication exceeded ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    return await body(controller.signal);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', abort);
  }
}
