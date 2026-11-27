import { createHash } from 'node:crypto';
import { z } from 'zod';
import { abortReason, linkAbortSignals } from '../internal/abort-race';
import { type BoundedChannel, createBoundedChannel } from '../internal/channel';
import { jsonDataRefusal } from '../internal/json-data';
import { runNativeCommand } from '../process/command';
import type { EngineProcess } from './engine-process';
import { type ExecutorProfileConfig, engineEnvironment } from './profile';
import {
  type ExecutorDelta,
  type ExecutorStartupPhase,
  ExecutorStartupPhaseSchema,
} from './vocabulary';

export const TURN_QUEUE = { maxItems: 65_536, maxBytes: 64 * 1024 * 1024 };
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

/** Trim and clamp a plan or bucket label to `maxChars` (default 256), returning `undefined` when blank. */
export function clampPlanName(
  value: string | null | undefined,
  maxChars = 256,
): string | undefined {
  const trimmed = nonEmptyString(value)?.trim();
  return trimmed !== undefined ? trimmed.slice(0, maxChars) : undefined;
}

/** Convert epoch milliseconds to ISO-8601 when within JavaScript `Date` range; otherwise `undefined`. */
export function epochMsToIso(ms: number | null | undefined): string | undefined {
  if (ms === null || ms === undefined) return undefined;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return undefined;
  return new Date(ms).toISOString();
}

/** Convert epoch seconds to ISO-8601 when within JavaScript `Date` range; otherwise `undefined`. */
export function epochSecondsToIso(seconds: number | null | undefined): string | undefined {
  if (seconds === null || seconds === undefined) return undefined;
  return epochMsToIso(seconds * 1000);
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

/** Why a session can no longer be used. */
export interface SessionStop {
  readonly reason: unknown;
}

/**
 * Whether a session can still be used, and why not. Every driver asks this one owner; none
 * keeps its own `closing`/`dead` flags or its own order of checks.
 */
export interface SessionLiveness {
  /** `close()` began: from here the session refuses with its closed message. */
  markClosing(): void;
  /** The engine, or the thread, was lost with `reason`. The first loss is the one kept. */
  markLost(reason: unknown): void;
  /** Whether `close()` began. */
  readonly closing: boolean;
  /** The loss `markLost` recorded, when there was one. */
  readonly lost: SessionStop | undefined;
  /** Whether the caller's own signal aborted, as opposed to the session ending by itself. */
  readonly abortedByCaller: boolean;
  /** `close()` began and the engine still reads: what arrives now can still be answered. */
  readonly closingGracefully: boolean;
  /**
   * Why the engine no longer reads this session, whether or not `close()` began: the recorded
   * loss, then the owner it lives in (`within`), then the caller's abort, then the session's own
   * abort. `undefined` while a closing session still talks to its engine.
   */
  terminated(): SessionStop | undefined;
  /**
   * Why the session stopped, or `undefined` while it is alive: closing first, then what
   * `terminated()` names. One order for every driver.
   */
  stopped(): SessionStop | undefined;
  /** Throw the reason `stopped()` names; return while the session is alive. */
  ensureAlive(): void;
  /** `stopped() === undefined`: what a reader loop, a handler or an observer guard asks. */
  isAlive(): boolean;
}

/**
 * The liveness of one session over the signals {@link sessionAbort} linked: `caller` is the
 * signal the caller gave, `linked` the session's own. `within` is the liveness of an owner the
 * session cannot outlive — the shared server a thread runs on.
 */
export function sessionLiveness(input: {
  /** What `ensureAlive()` throws once `close()` began. */
  readonly closedMessage: string;
  readonly caller: AbortSignal | undefined;
  readonly linked: AbortSignal;
  readonly within?: Pick<SessionLiveness, 'stopped'> | undefined;
}): SessionLiveness {
  let closed: SessionStop | undefined;
  let lost: SessionStop | undefined;
  const terminated = (): SessionStop | undefined => {
    if (lost !== undefined) return lost;
    const owner = input.within?.stopped();
    if (owner !== undefined) return owner;
    if (input.caller?.aborted) return { reason: abortReason(input.caller) };
    if (input.linked.aborted) return { reason: abortReason(input.linked) };
    return undefined;
  };
  const stopped = (): SessionStop | undefined => closed ?? terminated();
  return {
    markClosing() {
      closed ??= { reason: new Error(input.closedMessage) };
    },
    markLost(reason) {
      lost ??= { reason };
    },
    get closing() {
      return closed !== undefined;
    },
    get lost() {
      return lost;
    },
    get abortedByCaller() {
      return input.caller?.aborted === true;
    },
    get closingGracefully() {
      return closed !== undefined && terminated() === undefined;
    },
    terminated,
    stopped,
    ensureAlive() {
      const stop = stopped();
      if (stop !== undefined) throw stop.reason;
    },
    isAlive: () => stopped() === undefined,
  };
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

/**
 * Receives a failure the driver contained so it could keep reading its engine. `hook` names what
 * failed: the option of the host callback that threw or rejected (`'onNotification'`,
 * `'onDisconnect'`), or a step of the driver's own (`'driver:notification'`, `'query.close'`).
 */
export type ObserverErrorHandler = (error: unknown, hook: string) => void;

/** Hand a contained failure to `onObserverError`; the handler's own failure is dropped. */
export function reportObserverError(
  onObserverError: ObserverErrorHandler | undefined,
  hook: string,
  error: unknown,
): void {
  if (onObserverError === undefined) return;
  try {
    const reported: unknown = onObserverError(error, hook);
    if (isThenable(reported)) void Promise.resolve(reported).catch(() => undefined);
  } catch {
    // The reporter is the last place a contained failure can go: its own failure has none.
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Invoke a host callback or cleanup step so that neither a synchronous throw nor an async
 * rejection reaches the reader loop or masks a primary error; the failure goes to
 * `onObserverError` with the name of what failed. Without a handler it is contained and dropped.
 */
export function invokeObserver(
  onObserverError: ObserverErrorHandler | undefined,
  hook: string,
  invoke: () => unknown,
): void {
  try {
    const result = invoke();
    if (isThenable(result)) {
      void Promise.resolve(result).catch((error: unknown) =>
        reportObserverError(onObserverError, hook, error),
      );
    }
  } catch (error) {
    reportObserverError(onObserverError, hook, error);
  }
}

/** Validate and forward a session startup phase to an optional observer without letting throws break `open()`. */
export function emitStartupPhase(
  callback: ((phase: ExecutorStartupPhase) => void) | undefined,
  phase: ExecutorStartupPhase,
  onObserverError?: ObserverErrorHandler,
): void {
  if (callback === undefined) return;
  const parsed = ExecutorStartupPhaseSchema.parse(phase);
  invokeObserver(onObserverError, 'onStartupPhase', () => callback(parsed));
}

/**
 * Clamp a plan-window name (`prefix + suffix`) to at most `maxChars` characters and
 * deterministically disambiguate collisions via a short SHA-256 tag.
 */
export function clampUniqueWindowName(
  prefix: string,
  suffix: string,
  seenNames: Set<string>,
  disambiguatorSeed: string,
  maxChars = 256,
): string {
  const maxPrefix = Math.max(1, maxChars - suffix.length);
  let candidate =
    prefix.length > maxPrefix
      ? `${prefix.slice(0, maxPrefix)}${suffix}`.slice(0, maxChars)
      : `${prefix}${suffix}`;
  if (!seenNames.has(candidate)) {
    seenNames.add(candidate);
    return candidate;
  }
  const digest = createHash('sha256').update(disambiguatorSeed).digest('hex').slice(0, 8);
  const tag = `#${digest}${suffix}`;
  const room = Math.max(1, maxChars - tag.length);
  candidate = `${prefix.slice(0, room)}${tag}`.slice(0, maxChars);
  let index = 2;
  while (seenNames.has(candidate)) {
    const indexedTag = `#${digest}_${index}${suffix}`;
    const indexedRoom = Math.max(1, maxChars - indexedTag.length);
    candidate = `${prefix.slice(0, indexedRoom)}${indexedTag}`.slice(0, maxChars);
    index += 1;
  }
  seenNames.add(candidate);
  return candidate;
}
