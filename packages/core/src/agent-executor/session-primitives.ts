import { z } from 'zod';
import { abortReason, linkAbortSignals } from '../internal/abort-race';
import { type BoundedChannel, createBoundedChannel } from '../internal/channel';
import { jsonDataRefusal } from '../internal/json-data';
import { runNativeCommand } from '../process/command';
import type { EngineProcess } from './engine-process';
import { type ExecutorProfileConfig, engineEnvironment } from './profile';
import type { ExecutorDelta } from './vocabulary';

const TURN_QUEUE = { maxItems: 65_536, maxBytes: 64 * 1024 * 1024 };
const MAX_DATE_MS = 8.64e15;
const SAFE_JSON_LIMITS = {
  maxDepth: 100,
  maxNodes: 100_000,
  omitObjectUndefined: true,
  zodJson: true,
} as const;

/** Return `value` when it contains non-whitespace characters, else `undefined`. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Convert epoch seconds to ISO-8601 when within JavaScript `Date` range; otherwise `undefined`. */
export function epochSecondsToIso(seconds: number | null | undefined): string | undefined {
  if (seconds === null || seconds === undefined) return undefined;
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return undefined;
  return new Date(ms).toISOString();
}

/** Create the bounded ordered delta channel for a single turn. */
export function createTurnDeltaChannel(): BoundedChannel<ExecutorDelta> {
  return createBoundedChannel<ExecutorDelta>({
    policy: 'ordered',
    ...TURN_QUEUE,
    sizeOf: (delta) => JSON.stringify(delta).length,
  });
}

function normalizeDeltaIdentifiers(delta: ExecutorDelta): ExecutorDelta {
  if (delta.type === 'tool-call' || delta.type === 'tool-result') {
    const callId = nonEmptyString(delta.callId) ?? delta.itemId;
    const toolName = nonEmptyString(delta.toolName) ?? 'unknown';
    if (callId === delta.callId && toolName === delta.toolName) return delta;
    return { ...delta, callId, toolName };
  }
  if (delta.type === 'request') {
    const callId = nonEmptyString(delta.callId);
    const toolName =
      delta.toolName === undefined ? undefined : (nonEmptyString(delta.toolName) ?? 'tool');
    if (callId === delta.callId && toolName === delta.toolName) return delta;
    const { callId: _callId, toolName: _toolName, ...rest } = delta;
    return {
      ...rest,
      ...(callId !== undefined && { callId }),
      ...(toolName !== undefined && { toolName }),
    };
  }
  return delta;
}

/** Push a delta into a turn's channel, failing the channel if its bounds refuse it. */
export function offerTurnDelta(
  channel: BoundedChannel<ExecutorDelta> | undefined,
  delta: ExecutorDelta,
): void {
  if (channel === undefined) return;
  const result = channel.offer(normalizeDeltaIdentifiers(delta));
  if (result.outcome === 'refused' && result.reason !== 'not-open') {
    channel.fail(new Error(`The turn's delta queue refused a delta (${result.reason})`));
  }
}

/** A session's own abort, following the caller's signal until the session ends. */
export interface SessionAbort {
  /** Aborts with the caller's reason, or when the session calls `abort()`. */
  readonly signal: AbortSignal;
  /** End the session's work: aborts `signal` and detaches from the caller. */
  abort(): void;
  /** Detach from the caller and leave `signal` as it is — for a session that never started. */
  release(): void;
}

/**
 * Refuse a caller signal that already aborted, with its reason; otherwise link it, by
 * `linkAbortSignals`, to a controller the session owns.
 */
export function sessionAbort(caller: AbortSignal | undefined): SessionAbort {
  if (caller?.aborted) throw abortReason(caller);
  const own = new AbortController();
  const link = caller
    ? linkAbortSignals(caller, own.signal)
    : { signal: own.signal, release: () => undefined };
  return { signal: link.signal, abort: () => own.abort(), release: link.release };
}

/** Run a short-lived engine CLI command (`--version`, auth status) with the profile's allowlisted env. */
export function runEngineCli(input: {
  executable: string;
  prefix: readonly string[];
  args: readonly string[];
  profile: ExecutorProfileConfig;
  ambient: Readonly<Record<string, string | undefined>>;
}) {
  return runNativeCommand({
    executable: input.executable,
    args: [...input.prefix, ...input.args],
    env: engineEnvironment(input.profile, input.ambient),
    envPolicy: 'declared-only',
    capture: true,
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 30_000,
  });
}

/** An engine process and the loop reading it: what {@link stopConnection} stops. */
export interface EngineConnection {
  readonly engine: Pick<EngineProcess, 'stop'>;
  readonly reading: Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stop the engine and wait for its reader. A stop that fails while the caller is
 * already failing (`primary`) never takes that failure's place: both are thrown as one
 * `AggregateError` whose `cause` is the primary failure. With no primary failure the
 * stop's own failure is thrown. The reader is awaited either way — a failed stop
 * destroys the process's pipes, so the reader ends.
 */
export async function stopConnection(
  connection: EngineConnection,
  primary?: { readonly error: unknown },
): Promise<void> {
  let stopFailure: { error: unknown } | undefined;
  try {
    await connection.engine.stop();
  } catch (error) {
    stopFailure = { error };
  }
  await connection.reading;
  if (stopFailure === undefined) return;
  if (primary === undefined) throw stopFailure.error;
  throw new AggregateError(
    [primary.error, stopFailure.error],
    `${errorText(primary.error)}; stopping the engine also failed: ${errorText(stopFailure.error)}`,
    { cause: primary.error },
  );
}

/**
 * Open a one-shot engine connection, run `use`, and always abort, stop, and drain its
 * reader. A failure of `use` stays the failure ({@link stopConnection}). An answer `use`
 * already has is the probe's answer and is returned even when stopping afterwards fails:
 * the stop failure does not replace it, and the process group it left is the owner's to
 * reap (`ownerLoss: 'terminate'`). That stop failure is not reported anywhere: a probe
 * (`info`, `status`, model listing) has no logger to hand it to, and no driver config
 * carries one — a caller that must see it opens a session and closes it itself.
 */
export async function withEphemeralConnection<C extends EngineConnection, T>(
  connect: (signal: AbortSignal) => Promise<C>,
  use: (connection: C) => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  const connection = await connect(stop.signal);
  let answer: T;
  try {
    answer = await use(connection);
  } catch (error) {
    stop.abort();
    await stopConnection(connection, { error });
    throw error;
  }
  stop.abort();
  try {
    await stopConnection(connection);
  } catch {
    // The answer stands and the stop failure has nowhere to go; see above.
  }
  return answer;
}

/** Validate and clone a value into bounded JSON data without `JSON.parse(JSON.stringify(...))`. */
export function safeJsonValue(value: unknown): z.infer<ReturnType<typeof z.json>> {
  const snapshot: { value?: unknown } = {};
  const refusal = jsonDataRefusal(value, SAFE_JSON_LIMITS, snapshot);
  if (refusal !== undefined) {
    throw new TypeError(`Expected bounded JSON data (refused: ${refusal})`);
  }
  return z.json().parse(snapshot.value);
}
