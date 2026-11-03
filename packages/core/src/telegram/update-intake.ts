/**
 * Webhook updates received durably: recorded before Telegram is answered,
 * handled after, and never lost to a restart or a slow handler.
 *
 * Answering Telegram only after an update is handled breaks twice. A long
 * handler — a file of gigabytes arriving from a local Bot API server — holds
 * the connection past Telegram's patience, it gives up and sends the update
 * again while the first attempt still runs; and a process that dies after
 * handling but before answering loses nothing Telegram knows about, while one
 * that dies before handling loses the update for good once it has answered.
 * So the body is written first and Telegram answered at once; handling runs
 * here, outside the request.
 *
 * Updates of one chat run one after another, in `update_id` order; different
 * chats run side by side up to `maxConcurrent`. An attempt holds a lease that
 * is renewed while its handler lives; a sweep takes over what was left —
 * `pending` whose process never got to it, `failed` whose retry is due,
 * `processing` whose lease nobody renewed. Delivery is at least once: a
 * handler that finished but could not be recorded as finished runs again.
 *
 * The start reads the whole queue into the lines of its chats, page by page,
 * and whatever arrives meanwhile waits for it: a line is ordered by when it was
 * joined, so the only way to keep a chat in `update_id` order after a crash is
 * for the rows the dead process left to join first. The attempt the crash
 * interrupted stays under its lease and comes when that lapses.
 */

import { isRecord } from '../internal/typed';
import { classifyTelegramSendFailure } from './send-failure';
import {
  createTelegramUpdateAttemptRunner,
  createTelegramUpdateExhaustionScheduler,
  createTelegramUpdateLines,
  createTelegramUpdateWorkSlots,
  readTelegramUpdatesDue,
} from './update-intake-work';
import type {
  TelegramUpdateAttemptIdentity,
  TelegramUpdateDurableStore,
  TelegramUpdateFencedStore,
  TelegramUpdateStore,
} from './update-store';
import type { TelegramUpdateAcceptance } from './webhook';

/** An update as Telegram sends it; name grammY's `Update` to get its full type. */
export interface TelegramUpdateEnvelope {
  readonly update_id: number;
}

export interface TelegramUpdateFailure {
  readonly updateId: number;
  readonly attempt: number;
  readonly error: unknown;
  /** `false` when the update was abandoned — no attempt follows. */
  readonly retrying: boolean;
}

/** One handler invocation under one immutable store claim. */
export interface TelegramUpdateAttemptContext extends TelegramUpdateAttemptIdentity {
  /** Pass this exact identity to a fenced store check inside the consumer's DB transaction. */
  readonly fence: TelegramUpdateAttemptIdentity;
  /** Aborted once renewal proves the attempt lost ownership or its last proven lease expires. */
  readonly ownerLost: AbortSignal;
}

/** A terminal update failure recovered from the same durable update store. */
export interface TelegramUpdateExhaustion<TUpdate extends TelegramUpdateEnvelope>
  extends TelegramUpdateAttemptIdentity {
  readonly update: TUpdate;
  readonly exhaustedAt: number;
  readonly error: string;
}

/** A failed delivery of a durable terminal-update obligation. */
export interface TelegramUpdateExhaustionFailure<TUpdate extends TelegramUpdateEnvelope> {
  readonly exhaustion: TelegramUpdateExhaustion<TUpdate>;
  readonly error: unknown;
}

/** The reason carried by `ownerLost` when an attempt no longer owns its lease. */
export class TelegramUpdateOwnershipLostError extends Error {
  constructor(public readonly identity: TelegramUpdateAttemptIdentity) {
    super(
      `[stitchkit] telegram update ${identity.updateId} attempt ${identity.attempt} lost ownership`,
    );
    this.name = 'TelegramUpdateOwnershipLostError';
  }
}

export type TelegramUpdateStoreStep = 'claim' | 'renew' | 'settle' | 'sweep';

/** Retry, lease, scheduling and observation options shared by both handler forms. */
export interface TelegramUpdateIntakeOptions<TUpdate extends TelegramUpdateEnvelope> {
  /**
   * After a failed attempt: milliseconds until the next, or `false` to
   * abandon the update. Default: abandon what Telegram said repeating cannot
   * fix (a refused message, a blocked user), wait Telegram's `retry_after`
   * when it gave one, otherwise back off 5 s, 20 s, 80 s … up to 15 minutes.
   */
  readonly retry?: (error: unknown, attempt: number) => number | false;
  /** Default 5. */
  readonly maxAttempts?: number;
  /** How long an attempt holds its update without renewing. Default 120 000; renewed every quarter. */
  readonly leaseMs?: number;
  /** How long a `pending` update waits for this process before a sweep takes it. Default 60 000. */
  readonly pendingGraceMs?: number;
  /** Default 30 000. */
  readonly sweepEveryMs?: number;
  /** How long finished updates are remembered to refuse Telegram's repeats. Default 24 h. */
  readonly retainMs?: number;
  /** Chats handled at once. Default 32. */
  readonly maxConcurrent?: number;
  /** Every failed attempt. */
  readonly onFailure?: (failure: TelegramUpdateFailure) => void;
  /**
   * A durable final obligation. Resolving acknowledges it; throwing leaves it
   * in the same store for a later sweep. Requires a `TelegramUpdateDurableStore`.
   * Delivery is at least once, so persist by the supplied update/attempt identity.
   */
  readonly handleExhaustion?: (exhaustion: TelegramUpdateExhaustion<TUpdate>) => unknown;
  /** An observational report that `handleExhaustion` threw; it never acknowledges the row. */
  readonly onExhaustionFailure?: (failure: TelegramUpdateExhaustionFailure<TUpdate>) => void;
  /** A step failed; the update stays recorded and a later sweep takes it. */
  readonly onStoreError?: (error: unknown, step: TelegramUpdateStoreStep) => void;
  /** Default `Date.now`. */
  readonly now?: () => number;
}

/** Existing one-argument intake configuration. */
export interface TelegramUpdateIntakeConfig<TUpdate extends TelegramUpdateEnvelope>
  extends TelegramUpdateIntakeOptions<TUpdate> {
  readonly store: TelegramUpdateStore;
  /** Direct grammY handlers keep their optional second argument private. */
  readonly handle: (update: TUpdate) => unknown;
}

/** Intake configuration for a handler that needs attempt ownership metadata. */
export interface TelegramUpdateAttemptIntakeConfig<TUpdate extends TelegramUpdateEnvelope>
  extends TelegramUpdateIntakeOptions<TUpdate> {
  readonly store: TelegramUpdateFencedStore;
  /** Handle an update with its immutable attempt fence and ownership-loss signal. */
  readonly handleAttempt: (update: TUpdate, context: TelegramUpdateAttemptContext) => unknown;
}

type TelegramUpdateAnyIntakeConfig<TUpdate extends TelegramUpdateEnvelope> =
  | TelegramUpdateIntakeConfig<TUpdate>
  | TelegramUpdateAttemptIntakeConfig<TUpdate>;

export interface TelegramUpdateIntake {
  /** Record one webhook body; handling starts after, once the intake is started. */
  accept(body: string): Promise<TelegramUpdateAcceptance>;
  /**
   * Start handling, beginning with everything recorded before. Resolves once
   * that queue is scheduled, not handled; `accept` works throughout.
   */
  start(): Promise<void>;
  /** Take over everything due now; how many updates were scheduled. */
  sweep(): Promise<number>;
  /** Resolves once nothing is scheduled. */
  idle(): Promise<void>;
  /** Stop scheduling and wait for the handlers in flight. */
  close(): Promise<void>;
}

const SWEEP_BATCH = 100;

function defaultRetry(error: unknown, attempt: number): number | false {
  const failure = classifyTelegramSendFailure(error);
  if (failure.evidence !== 'none' && !failure.retryable) return false;
  const backoff = Math.min(5_000 * 4 ** (attempt - 1), 15 * 60_000);
  return Math.max(backoff, (failure.retryAfterSeconds ?? 0) * 1_000);
}

function parsed(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) &&
      Number.isSafeInteger(value.update_id) &&
      Number(value.update_id) >= 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`[stitchkit] telegram update intake: ${name} is a positive integer`);
  }
  return value;
}

function isTelegramUpdateFencedStore(
  store: TelegramUpdateStore,
): store is TelegramUpdateFencedStore {
  return (
    'claimOwned' in store &&
    typeof store.claimOwned === 'function' &&
    'renewOwned' in store &&
    typeof store.renewOwned === 'function' &&
    'owns' in store &&
    typeof store.owns === 'function' &&
    'settleOwned' in store &&
    typeof store.settleOwned === 'function'
  );
}

function isTelegramUpdateDurableStore(
  store: TelegramUpdateStore,
): store is TelegramUpdateDurableStore {
  return (
    isTelegramUpdateFencedStore(store) &&
    'exhaust' in store &&
    typeof store.exhaust === 'function' &&
    'dueExhaustions' in store &&
    typeof store.dueExhaustions === 'function' &&
    'acknowledgeExhaustion' in store &&
    typeof store.acknowledgeExhaustion === 'function'
  );
}

/** What the chosen handlers need of the store; a store short of it refuses at construction. */
function storeCapabilities<TUpdate extends TelegramUpdateEnvelope>(
  config: TelegramUpdateAnyIntakeConfig<TUpdate>,
): {
  readonly fenced: TelegramUpdateFencedStore | undefined;
  readonly durable: TelegramUpdateDurableStore | undefined;
} {
  const { store } = config;
  const exhaustionHandler = config.handleExhaustion;
  const attemptAware = 'handleAttempt' in config;
  const fenced =
    attemptAware || exhaustionHandler !== undefined
      ? isTelegramUpdateFencedStore(store)
        ? store
        : undefined
      : undefined;
  const durable = exhaustionHandler
    ? isTelegramUpdateDurableStore(store)
      ? store
      : undefined
    : undefined;
  if (attemptAware && !fenced) {
    throw new TypeError(
      '[stitchkit] telegram update intake: handleAttempt requires a TelegramUpdateFencedStore',
    );
  }
  if (exhaustionHandler && !durable) {
    throw new TypeError(
      '[stitchkit] telegram update intake: handleExhaustion requires a TelegramUpdateDurableStore',
    );
  }
  return { fenced, durable };
}

export function createTelegramUpdateIntake<TUpdate extends TelegramUpdateEnvelope>(
  config: TelegramUpdateIntakeConfig<TUpdate>,
): TelegramUpdateIntake;
export function createTelegramUpdateIntake<TUpdate extends TelegramUpdateEnvelope>(
  config: TelegramUpdateAttemptIntakeConfig<TUpdate>,
): TelegramUpdateIntake;
export function createTelegramUpdateIntake<TUpdate extends TelegramUpdateEnvelope>(
  config: TelegramUpdateAnyIntakeConfig<TUpdate>,
): TelegramUpdateIntake {
  const { store } = config;
  const { fenced, durable } = storeCapabilities(config);
  const now = config.now ?? Date.now;
  const retry = config.retry ?? defaultRetry;
  const maxAttempts = positive('maxAttempts', config.maxAttempts ?? 5);
  const leaseMs = positive('leaseMs', config.leaseMs ?? 120_000);
  const pendingGraceMs = config.pendingGraceMs ?? 60_000;
  const sweepEveryMs = positive('sweepEveryMs', config.sweepEveryMs ?? 30_000);
  const retainMs = config.retainMs ?? 86_400_000;
  const maxConcurrent = positive('maxConcurrent', config.maxConcurrent ?? 32);
  let started = false;
  let starting: Promise<void> | undefined;
  let lifecycleGeneration = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let exhaustionCursor: number | undefined;
  let arrivals: Record<string, unknown>[] | undefined;

  const storeError = (error: unknown, step: TelegramUpdateStoreStep): void => {
    try {
      config.onStoreError?.(error, step);
    } catch {
      // An observer cannot turn a store failure into a lost update.
    }
  };

  const slots = createTelegramUpdateWorkSlots(maxConcurrent);
  const exhaustionScheduler = createTelegramUpdateExhaustionScheduler({
    config,
    store: durable,
    now,
    slots,
    parse: parsed,
    reportStoreError: storeError,
  });
  const attempt = createTelegramUpdateAttemptRunner({
    config,
    store,
    fenced,
    durable,
    now,
    retry,
    maxAttempts,
    leaseMs,
    reportStoreError: storeError,
    scheduleExhaustion: (row) => {
      exhaustionScheduler.schedule(row, started);
    },
    ownershipLostReason: (identity) => new TelegramUpdateOwnershipLostError(identity),
  });

  const lines = createTelegramUpdateLines(async (update, updateId) => {
    await slots.take();
    try {
      // What `close` left in its line stays recorded for the next start.
      if (started) await attempt(update, updateId);
    } catch (error) {
      // A line outlives one attempt: the rows behind it stay behind it, this one under its lease.
      storeError(error, 'settle');
    } finally {
      slots.release();
    }
  });
  const schedule = (update: Record<string, unknown>): boolean =>
    started && lines.schedule(update);

  /** Rows join their lines in one pass, merged with `waiting`, so nothing runs ahead of the read. */
  const sweep = async (
    pendingBefore: number,
    waiting: readonly Record<string, unknown>[] = [],
  ): Promise<number> => {
    const at = now();
    const generation = lifecycleGeneration;
    const rows = await readTelegramUpdatesDue(store, {
      now: at,
      pendingBefore,
      limit: SWEEP_BATCH,
      skip: lines.has,
      parse: parsed,
      reading: () => started,
    });
    if (generation !== lifecycleGeneration) return 0;
    if (arrivals === waiting) arrivals = undefined;
    const waited = new Set(waiting);
    const queue = [...rows, ...waiting].sort(
      (left, right) => Number(left.update_id) - Number(right.update_id),
    );
    let count = 0;
    for (const update of queue) {
      if (schedule(update) && !waited.has(update)) count += 1;
    }
    if (durable) {
      let exhaustions = await durable.dueExhaustions({
        limit: SWEEP_BATCH,
        ...(exhaustionCursor !== undefined && { afterUpdateId: exhaustionCursor }),
      });
      if (exhaustions.length === 0 && exhaustionCursor !== undefined) {
        exhaustionCursor = undefined;
        exhaustions = await durable.dueExhaustions({ limit: SWEEP_BATCH });
      }
      exhaustionCursor = exhaustions.at(-1)?.updateId;
      for (const exhaustion of exhaustions) {
        if (exhaustionScheduler.schedule(exhaustion, started)) count += 1;
      }
    }
    await store.prune(at - retainMs);
    return count;
  };

  const drained = async (): Promise<void> => {
    while (lines.pending().length > 0 || exhaustionScheduler.pending().length > 0) {
      await Promise.all([...lines.pending(), ...exhaustionScheduler.pending()]);
    }
  };

  return {
    async accept(body) {
      const update = parsed(body);
      if (!update) return 'invalid';
      const updateId = Number(update.update_id);
      const added = await store.add({ updateId, body, receivedAt: now() });
      if (!added) return 'duplicate';
      if (arrivals) arrivals.push(update);
      else schedule(update);
      return 'accepted';
    },
    start() {
      if (starting) return starting;
      if (started) return Promise.resolve();
      started = true;
      const generation = ++lifecycleGeneration;
      const waiting: Record<string, unknown>[] = [];
      arrivals = waiting;
      const operation = (async () => {
        try {
          await sweep(now(), waiting);
        } catch (error) {
          if (started && lifecycleGeneration === generation) started = false;
          throw error;
        } finally {
          if (arrivals === waiting) arrivals = undefined;
        }
        if (!started || lifecycleGeneration !== generation) return;
        timer = setInterval(() => {
          if (!started || lifecycleGeneration !== generation) return;
          sweep(now() - pendingGraceMs).catch((error: unknown) => storeError(error, 'sweep'));
        }, sweepEveryMs);
        timer.unref?.();
      })();
      starting = operation;
      const clearStarting = (): void => {
        if (starting === operation) starting = undefined;
      };
      void operation.then(clearStarting, clearStarting);
      return operation;
    },
    sweep: () => sweep(now() - pendingGraceMs),
    async idle() {
      await starting?.catch(() => undefined);
      await drained();
    },
    async close() {
      started = false;
      lifecycleGeneration += 1;
      if (timer) clearInterval(timer);
      timer = undefined;
      const pendingStart = starting;
      if (pendingStart) {
        await pendingStart.then(
          () => undefined,
          () => undefined,
        );
      }
      await drained();
    },
  };
}
