import { ConnectionResponseTooLargeError, ConnectionTimeoutError } from './errors';
import type { ConnectionReadContext } from './operation-limits';

/** Shared defaults for both connection kinds; phase overrides inherit these. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

export function connectionTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONNECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RangeError('Connection timeoutMs must be a positive integer within timer range');
  }
  return value;
}

export function connectionMaxResponseBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('Connection maxResponseBytes must be a positive safe integer');
  }
  return value;
}

/** Abort races also cover injected streams or promises that do not observe fetch's signal. */
export async function awaitConnection<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    signal.throwIfAborted();
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await Promise.race([pending, aborted.promise]);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** One deadline spans negotiation, response waiting and all body reads. */
export async function withConnectionDeadline<T>(
  connectionName: string,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
  context?: ConnectionReadContext,
): Promise<T> {
  connectionTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ConnectionTimeoutError(connectionName, timeoutMs, context)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  if (context) context.signal = controller.signal;
  try {
    controller.signal.throwIfAborted();
    return await awaitConnection(body(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}

/** Count raw bytes; Content-Length is deliberately not a trust boundary. */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  connectionName: string,
  context?: ConnectionReadContext,
): Promise<string> {
  context?.signal?.throwIfAborted();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  const cancel = () => void reader.cancel(context?.signal?.reason).catch(() => undefined);
  context?.signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await awaitConnection(reader.read(), context?.signal);
      if (done) break;
      total += value.byteLength;
      if (context) context.observedReadBytes += value.byteLength;
      if (total > maxBytes) {
        throw new ConnectionResponseTooLargeError(connectionName, maxBytes, {
          ...context,
          observedReadBytes: total,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    context?.signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  connectionName: string,
  context?: ConnectionReadContext,
): Promise<unknown> {
  return JSON.parse(await readBoundedText(response, maxBytes, connectionName, context));
}

/** Diagnostics are best effort; cancellation and declared bounds always win. */
export async function readConnectionErrorText(
  response: Response,
  connectionName: string,
  context: ConnectionReadContext,
): Promise<string> {
  try {
    return (
      await readBoundedText(response, context.maxResponseBytes, connectionName, context)
    ).slice(0, 512);
  } catch (error) {
    context.signal?.throwIfAborted();
    if (
      error instanceof ConnectionResponseTooLargeError ||
      error instanceof ConnectionTimeoutError
    ) {
      throw error;
    }
    return '';
  }
}
