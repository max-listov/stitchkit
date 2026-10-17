import { raceAbort } from '../../internal/abort-race';
import { concatChunks, readBoundedChunks } from '../../internal/bounded-body';
import { withSignalDeadline } from '../../internal/deadline';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { MAX_TIMER_MS } from '../../internal/timers';
import { ConnectionResponseTooLargeError, ConnectionTimeoutError } from './errors';
import type { ConnectionReadContext } from './operation-limits';

/** Shared defaults for both connection kinds; phase overrides inherit these. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export function connectionTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONNECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RangeError('Connection timeoutMs must be a positive integer within timer range');
  }
  return value;
}

export function connectionMaxResponseBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  assertPositiveSafeInteger('Connection maxResponseBytes', value, RangeError);
  return value;
}

/** Abort races also cover injected streams or promises that do not observe fetch's signal. */
export function awaitConnection<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  return signal ? raceAbort(pending, signal) : pending;
}

/**
 * One deadline spans negotiation, response waiting and all body reads.
 *
 * `body` receives a copy of `context` that carries the deadline signal, so the caller's
 * own context object is never changed and a context reused across operations never holds a
 * stale signal. The copy is the one whose read counters a timeout reports.
 */
export function withConnectionDeadline<T>(
  connectionName: string,
  context: ConnectionReadContext,
  callerSignal: AbortSignal | undefined,
  body: (scoped: ConnectionReadContext) => Promise<T>,
): Promise<T> {
  const timeoutMs = connectionTimeoutMs(context.timeoutMs);
  let scoped = context;
  return withSignalDeadline(
    timeoutMs,
    callerSignal,
    () => new ConnectionTimeoutError(connectionName, timeoutMs, scoped),
    (signal) => {
      scoped = { ...context, signal };
      return raceAbort(body(scoped), signal);
    },
  );
}

/** Count raw bytes; Content-Length is deliberately not a trust boundary. */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  connectionName: string,
  context?: ConnectionReadContext,
): Promise<string> {
  const result = await readBoundedChunks(response.body, {
    maxBytes,
    ...(context?.signal && { signal: context.signal }),
    onChunk: (chunk) => {
      if (context) context.observedReadBytes += chunk.byteLength;
    },
  });
  if (result.kind === 'over-limit') {
    throw new ConnectionResponseTooLargeError(connectionName, maxBytes, {
      ...context,
      observedReadBytes: result.total,
    });
  }
  return new TextDecoder().decode(concatChunks(result.chunks, result.total));
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
