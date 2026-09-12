import { ConnectionResponseTooLargeError, ConnectionTimeoutError } from './errors';

/**
 * Bounds shared by both connection kinds.
 *
 * ADR 0180 says timeouts and response sizes are bounded; before this module
 * neither was. Every outbound `fetch` runs under a deadline that aborts with a
 * typed {@link ConnectionTimeoutError} and is combined with any caller signal,
 * and every JSON/text body is read through {@link readBoundedText}.
 */

/** Default per-request deadline: long enough for a slow provider, finite. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

/** Default response ceiling: 1 MiB, far above any tool payload we accept. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** The declared timeout, or the default when absent or non-positive. */
export function connectionTimeoutMs(value: number | undefined): number {
  return value !== undefined && value > 0 ? value : DEFAULT_CONNECTION_TIMEOUT_MS;
}

/** The declared response ceiling, or the default when absent or non-positive. */
export function connectionMaxResponseBytes(value: number | undefined): number {
  return value !== undefined && value > 0 ? value : DEFAULT_MAX_RESPONSE_BYTES;
}

/**
 * Run `body` under a request deadline, passing it the combined signal.
 *
 * The signal aborts with a typed `ConnectionTimeoutError` once `timeoutMs`
 * elapses, and mirrors the caller's own signal so an application abort still
 * wins. `body` must thread the signal into every `fetch` and body read it
 * performs — the deadline covers both, not just the connection setup.
 */
export async function withConnectionDeadline<T>(
  connectionName: string,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ConnectionTimeoutError(connectionName, timeoutMs)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await body(controller.signal);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read a response body up to `maxBytes`, refusing anything above it.
 *
 * The stream is cancelled as soon as the ceiling is crossed, so an unbounded
 * server cannot keep the process reading. Returns the decoded text so a JSON
 * caller can parse it itself and a text caller gets it unchanged.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  connectionName: string,
): Promise<string> {
  const stream = response.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ConnectionResponseTooLargeError(connectionName, maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Parse a bounded JSON body, keeping the ceiling check in one place. */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  connectionName: string,
): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes, connectionName);
  return JSON.parse(text);
}
