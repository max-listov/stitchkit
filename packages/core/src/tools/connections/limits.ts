import { raceAbort } from '../../internal/abort-race';
import { concatChunks, readBoundedChunks } from '../../internal/bounded-body';
import { assertTimerMs, withIdleDeadline, withSignalDeadline } from '../../internal/deadline';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { ConnectionResponseTooLargeError, ConnectionTimeoutError } from './errors';
import type { ConnectionReadContext } from './operation-limits';

/** Shared defaults for both connection kinds; phase overrides inherit these. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * MCP discovery's own defaults when nothing names a deadline: a catalog of a few hundred tools
 * is hundreds of kilobytes, which a slow link delivers in minutes, so the bound that ends a dead
 * discovery is silence, not length.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 300_000;
export const DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS = 30_000;

export function connectionTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONNECTION_TIMEOUT_MS;
  assertTimerMs('Connection timeoutMs', value);
  return value;
}

export function connectionIdleTimeoutMs(value: number | undefined): number | undefined {
  assertTimerMs('Connection idleTimeoutMs', value);
  return value;
}

/** Count bytes read for an operation; every chunk is progress for its idle deadline. */
export function recordConnectionRead(context: ConnectionReadContext, bytes: number): void {
  context.observedReadBytes += bytes;
  context.touch?.();
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
 * One deadline spans negotiation, response waiting and all body reads; an optional idle
 * deadline inside it ends the operation when nothing arrives for `idleTimeoutMs` — response
 * headers and every body chunk restart it.
 *
 * `body` receives a copy of `context` that carries the deadline signal and the progress hook,
 * so the caller's own context object is never changed and a context reused across operations
 * never holds a stale signal. The copy is the one whose read counters a timeout reports.
 */
export function withConnectionDeadline<T>(
  connectionName: string,
  context: ConnectionReadContext,
  callerSignal: AbortSignal | undefined,
  body: (scoped: ConnectionReadContext) => Promise<T>,
): Promise<T> {
  const timeoutMs = connectionTimeoutMs(context.timeoutMs);
  const idleTimeoutMs = connectionIdleTimeoutMs(context.idleTimeoutMs);
  let scoped = context;
  return withSignalDeadline(
    timeoutMs,
    callerSignal,
    () => new ConnectionTimeoutError(connectionName, timeoutMs, scoped),
    (signal) =>
      withIdleDeadline(
        idleTimeoutMs,
        signal,
        () =>
          new ConnectionTimeoutError(connectionName, idleTimeoutMs ?? timeoutMs, {
            ...scoped,
            deadline: 'idle',
          }),
        (idle) => {
          scoped = { ...context, signal: idle.signal, touch: idle.touch };
          return raceAbort(body(scoped), idle.signal);
        },
      ),
  );
}

/** Count raw bytes; Content-Length is deliberately not a trust boundary. */
export async function readBoundedConnectionText(
  response: Response,
  maxBytes: number,
  connectionName: string,
  context?: ConnectionReadContext,
): Promise<string> {
  const result = await readBoundedChunks(response.body, {
    maxBytes,
    ...(context?.signal && { signal: context.signal }),
    onChunk: (chunk) => {
      if (context) recordConnectionRead(context, chunk.byteLength);
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
  return JSON.parse(
    await readBoundedConnectionText(response, maxBytes, connectionName, context),
  );
}

/** Diagnostics are best effort; cancellation and declared bounds always win. */
export async function readConnectionErrorText(
  response: Response,
  connectionName: string,
  context: ConnectionReadContext,
): Promise<string> {
  try {
    return (
      await readBoundedConnectionText(
        response,
        context.maxResponseBytes,
        connectionName,
        context,
      )
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
