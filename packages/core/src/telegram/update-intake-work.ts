import { isRecord, transportResult } from '../internal/typed';
import type {
  TelegramUpdateAttemptContext,
  TelegramUpdateAttemptIntakeConfig,
  TelegramUpdateEnvelope,
  TelegramUpdateExhaustion,
  TelegramUpdateIntakeConfig,
  TelegramUpdateStoreStep,
} from './update-intake';
import type {
  StoredTelegramUpdateExhaustion,
  TelegramUpdateAttemptIdentity,
  TelegramUpdateDueQuery,
  TelegramUpdateDurableStore,
  TelegramUpdateFencedStore,
  TelegramUpdateStore,
} from './update-store';

type TelegramUpdateAnyIntakeConfig<TUpdate extends TelegramUpdateEnvelope> =
  | TelegramUpdateIntakeConfig<TUpdate>
  | TelegramUpdateAttemptIntakeConfig<TUpdate>;

export type TelegramUpdateStoreErrorReporter = (
  error: unknown,
  step: TelegramUpdateStoreStep,
) => void;

/** One shared concurrency budget for ordinary attempts and exhaustion delivery. */
export interface TelegramUpdateWorkSlots {
  take(): Promise<void>;
  release(): void;
}

export function createTelegramUpdateWorkSlots(maxConcurrent: number): TelegramUpdateWorkSlots {
  const waiting: (() => void)[] = [];
  let running = 0;
  return {
    async take() {
      if (running < maxConcurrent) {
        running += 1;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    },
  };
}

/** Updates of one chat keep their order; an update without a chat is its own line. */
function lineOf(update: Record<string, unknown>): string {
  for (const [key, payload] of Object.entries(update)) {
    if (key === 'update_id' || !isRecord(payload)) continue;
    const message = isRecord(payload.message) ? payload.message : undefined;
    for (const holder of [
      payload.chat,
      message?.chat,
      payload.from,
      payload.user,
      payload.voter_chat,
    ]) {
      if (
        isRecord(holder) &&
        (typeof holder.id === 'number' || typeof holder.id === 'string')
      ) {
        return `chat:${holder.id}`;
      }
    }
  }
  return `update:${String(update.update_id)}`;
}

/** The updates this process holds, each behind the earlier ones of its chat. */
export interface TelegramUpdateLines {
  has(updateId: number): boolean;
  /** Join the update's line; `false` when it is already in one. */
  schedule(update: Record<string, unknown>): boolean;
  pending(): readonly Promise<void>[];
}

export function createTelegramUpdateLines(
  run: (update: Record<string, unknown>, updateId: number) => Promise<void>,
): TelegramUpdateLines {
  const lines = new Map<string, Promise<void>>();
  const scheduled = new Set<number>();
  return {
    has: (updateId) => scheduled.has(updateId),
    schedule(update) {
      const updateId = Number(update.update_id);
      if (scheduled.has(updateId)) return false;
      scheduled.add(updateId);
      const line = lineOf(update);
      const next = (lines.get(line) ?? Promise.resolve())
        .then(() => run(update, updateId))
        .finally(() => {
          scheduled.delete(updateId);
          if (lines.get(line) === next) lines.delete(line);
        });
      lines.set(line, next);
      return true;
    },
    pending: () => [...lines.values()],
  };
}

/**
 * Every row due, read to the empty page. A scheduled row stays due until
 * claimed, so only a cursor reaches past the first page. A store on a
 * synchronous driver never leaves the microtask queue, so each page yields:
 * webhooks and lease renewals run during a read.
 */
export async function readTelegramUpdatesDue(
  store: TelegramUpdateStore,
  read: Omit<TelegramUpdateDueQuery, 'afterUpdateId'> & {
    readonly skip: (updateId: number) => boolean;
    readonly parse: (body: string) => Record<string, unknown> | undefined;
    readonly reading: () => boolean;
  },
): Promise<Record<string, unknown>[]> {
  const { skip, parse, reading, ...query } = read;
  const rows: Record<string, unknown>[] = [];
  let afterUpdateId: number | undefined;
  for (;;) {
    const due = await store.due({
      ...query,
      ...(afterUpdateId !== undefined && { afterUpdateId }),
    });
    for (const row of due) {
      if (afterUpdateId !== undefined && row.updateId <= afterUpdateId) {
        throw new TypeError(
          '[stitchkit] telegram update store: due returned a row at or before afterUpdateId',
        );
      }
      if (skip(row.updateId)) continue;
      const update = parse(row.body);
      if (update) rows.push(update);
    }
    afterUpdateId = due.at(-1)?.updateId;
    if (due.length === 0 || !reading()) return rows;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export interface TelegramUpdateExhaustionScheduler {
  schedule(row: StoredTelegramUpdateExhaustion, active: boolean): boolean;
  pending(): readonly Promise<void>[];
}

/** Deliver recoverable terminal obligations without creating another durable queue. */
export function createTelegramUpdateExhaustionScheduler<
  TUpdate extends TelegramUpdateEnvelope,
>(options: {
  readonly config: TelegramUpdateAnyIntakeConfig<TUpdate>;
  readonly store: TelegramUpdateDurableStore | undefined;
  readonly now: () => number;
  readonly slots: TelegramUpdateWorkSlots;
  readonly parse: (body: string) => Record<string, unknown> | undefined;
  readonly reportStoreError: TelegramUpdateStoreErrorReporter;
}): TelegramUpdateExhaustionScheduler {
  const { config, store, now, slots, parse, reportStoreError } = options;
  const handler = config.handleExhaustion;
  const jobs = new Map<number, Promise<void>>();
  return {
    schedule(row, active) {
      if (!active || !store || !handler || jobs.has(row.updateId)) return false;
      const update = parse(row.body);
      if (!update) return false;
      const exhaustion: TelegramUpdateExhaustion<TUpdate> = Object.freeze({
        update: transportResult<TUpdate>(update),
        updateId: row.updateId,
        attempt: row.attempt,
        claimId: row.claimId,
        exhaustedAt: row.exhaustedAt,
        error: row.error,
      });
      const job = (async () => {
        await slots.take();
        try {
          try {
            await handler(exhaustion);
          } catch (error) {
            try {
              config.onExhaustionFailure?.({ exhaustion, error });
            } catch {
              // Reporting an obligation failure cannot acknowledge it.
            }
            return;
          }
          await store
            .acknowledgeExhaustion(exhaustion, now())
            .catch((error: unknown) => reportStoreError(error, 'settle'));
        } finally {
          slots.release();
        }
      })().finally(() => {
        if (jobs.get(row.updateId) === job) jobs.delete(row.updateId);
      });
      jobs.set(row.updateId, job);
      return true;
    },
    pending: () => [...jobs.values()],
  };
}

/** Remove grammY's transport wrapper so policy and persisted text see the handler's error. */
function handlerError(error: unknown): unknown {
  return error instanceof Error &&
    error.name === 'BotError' &&
    'ctx' in error &&
    'error' in error
    ? error.error
    : error;
}

/** Build the claim/renew/settle state machine for one update attempt. */
export function createTelegramUpdateAttemptRunner<
  TUpdate extends TelegramUpdateEnvelope,
>(options: {
  readonly config: TelegramUpdateAnyIntakeConfig<TUpdate>;
  readonly store: TelegramUpdateStore;
  readonly fenced: TelegramUpdateFencedStore | undefined;
  readonly durable: TelegramUpdateDurableStore | undefined;
  readonly now: () => number;
  readonly retry: (error: unknown, attempt: number) => number | false;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly reportStoreError: TelegramUpdateStoreErrorReporter;
  readonly scheduleExhaustion: (row: StoredTelegramUpdateExhaustion) => void;
  readonly ownershipLostReason: (identity: TelegramUpdateAttemptIdentity) => unknown;
}): (update: Record<string, unknown>, updateId: number) => Promise<void> {
  const {
    config,
    store,
    fenced,
    durable,
    now,
    retry,
    maxAttempts,
    leaseMs,
    reportStoreError,
    scheduleExhaustion,
    ownershipLostReason,
  } = options;
  return async (update, updateId) => {
    const taken = now();
    const claimOptions = {
      now: taken,
      leaseUntil: taken + leaseMs,
      maxAttempts,
      ...(durable && { durableExhaustion: true }),
    };
    const ownedIdentity = fenced
      ? await fenced
          .claimOwned(updateId, claimOptions)
          .catch((error: unknown) => reportStoreError(error, 'claim'))
      : undefined;
    const legacyAttempt = fenced
      ? undefined
      : await store
          .claim(updateId, claimOptions)
          .catch((error: unknown) => reportStoreError(error, 'claim'));
    const attempt = ownedIdentity?.attempt ?? legacyAttempt;
    if (attempt === undefined) return;

    const identity: TelegramUpdateAttemptIdentity = Object.freeze(
      ownedIdentity ?? { updateId, attempt, claimId: '' },
    );
    const ownership = new AbortController();
    let active = true;
    const loseOwnership = (): void => {
      if (!ownership.signal.aborted) ownership.abort(ownershipLostReason(identity));
    };
    let ownershipDeadline: ReturnType<typeof setTimeout> | undefined;
    const armOwnershipDeadline = (leaseUntil: number): void => {
      if (!active) return;
      if (ownershipDeadline) clearTimeout(ownershipDeadline);
      ownershipDeadline = setTimeout(loseOwnership, Math.max(1, leaseUntil - now()));
      ownershipDeadline.unref?.();
    };
    armOwnershipDeadline(taken + leaseMs);
    let renewalInFlight = false;
    const renewal = setInterval(
      () => {
        if (!active || renewalInFlight) return;
        renewalInFlight = true;
        const at = now();
        const leaseUntil = at + leaseMs;
        let request: Promise<boolean>;
        try {
          request = fenced
            ? fenced.renewOwned(identity, leaseUntil, at)
            : store.renew(updateId, attempt, leaseUntil, at);
        } catch (error) {
          renewalInFlight = false;
          if (active) reportStoreError(error, 'renew');
          return;
        }
        request.then(
          (held) => {
            renewalInFlight = false;
            if (!active) return;
            if (held) armOwnershipDeadline(leaseUntil);
            else loseOwnership();
          },
          (error: unknown) => {
            renewalInFlight = false;
            if (active) reportStoreError(error, 'renew');
          },
        );
      },
      Math.max(1, Math.floor(leaseMs / 4)),
    );
    renewal.unref?.();

    const context: TelegramUpdateAttemptContext = Object.freeze({
      ...identity,
      fence: identity,
      ownerLost: ownership.signal,
    });
    const settleAttempt = (settlement: Parameters<TelegramUpdateStore['settle']>[2]) =>
      fenced
        ? fenced.settleOwned(identity, settlement)
        : store.settle(updateId, attempt, settlement).then(() => true);
    try {
      try {
        const typedUpdate = transportResult<TUpdate>(update);
        if ('handleAttempt' in config) await config.handleAttempt(typedUpdate, context);
        else await config.handle(typedUpdate);
        const settled = await settleAttempt({ state: 'completed', at: now() }).catch(
          (error: unknown) => {
            reportStoreError(error, 'settle');
            return false;
          },
        );
        if (settled === false) loseOwnership();
      } catch (thrown) {
        const error = handlerError(thrown);
        const delay = attempt >= maxAttempts ? false : retry(error, attempt);
        const message = error instanceof Error ? error.message : String(error);
        let exhaustion: StoredTelegramUpdateExhaustion | undefined;
        let retrying = delay !== false;
        if (delay === false && durable) {
          const at = now();
          const persisted = await durable
            .exhaust(identity, { at, error: message })
            .catch((cause) => {
              reportStoreError(cause, 'settle');
              return false;
            });
          if (persisted) {
            exhaustion = {
              ...identity,
              body: JSON.stringify(update),
              exhaustedAt: at,
              error: message,
            };
          } else {
            loseOwnership();
            retrying = true;
          }
        } else {
          const at = now();
          const settled = await settleAttempt(
            delay === false
              ? { state: 'abandoned', at, error: message }
              : { state: 'failed', at, retryAt: at + delay, error: message },
          ).catch((cause: unknown) => {
            reportStoreError(cause, 'settle');
            return false;
          });
          if (settled === false) {
            loseOwnership();
            retrying = true;
          }
        }
        try {
          config.onFailure?.({ updateId, attempt, error, retrying });
        } catch {
          // Reporting a failure cannot become a second one.
        }
        if (exhaustion) scheduleExhaustion(exhaustion);
      }
    } finally {
      active = false;
      clearInterval(renewal);
      if (ownershipDeadline) clearTimeout(ownershipDeadline);
    }
  };
}
