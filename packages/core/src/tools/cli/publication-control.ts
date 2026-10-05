import { raceAbort } from '../../internal/abort-race';
import { withSignalDeadline } from '../../internal/deadline';

/** A deadline cancels waits and blocks late promotion; trusted callbacks own their external effects. */
export function waitForPublication<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return raceAbort(operation, signal, (value) => {
    if (value instanceof ReadableStream && !value.locked)
      void value.cancel(signal.reason).catch(() => undefined);
  });
}

export function withPublicationDeadline<T>(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withSignalDeadline(
    timeoutMs,
    caller,
    () => new Error(`CLI publication exceeded ${timeoutMs} ms`),
    body,
  );
}
