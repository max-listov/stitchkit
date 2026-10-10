import { randomUUID } from 'node:crypto';

/**
 * Where received updates wait, and the rules a store keeps for them.
 *
 * The intake decides; the store only has to make each decision atomic, so two
 * processes sharing one store — an old release still draining beside a new one
 * — never run one update at once. Every rule is a condition on one record:
 *
 * - **claimable** at `now`: `pending`; `failed` whose `dueAt` has come;
 *   `processing` whose lease (`dueAt`) has lapsed — its process died;
 * - `claim` takes a claimable record whose `attempts` are under the limit —
 *   `processing`, `attempts + 1`, lease until `leaseUntil` — and settles one
 *   whose attempts are spent as `abandoned`;
 * - `renew` and `settle` act only while the record is still `processing` under
 *   the same attempt, so a process that lost its lease cannot overwrite the
 *   one that took it over;
 * - a durable abandonment keeps `settledAt` empty until the consumer has
 *   handled its final obligation. It stays in this record and is never pruned
 *   while it is pending.
 */

export type TelegramUpdateState =
  | 'pending'
  | 'processing'
  | 'failed'
  | 'completed'
  | 'abandoned';

export type TelegramUpdateSettlement =
  | { readonly state: 'completed'; readonly at: number }
  | {
      readonly state: 'failed';
      readonly at: number;
      readonly retryAt: number;
      readonly error: string;
    }
  | { readonly state: 'abandoned'; readonly at: number; readonly error: string };

export interface TelegramUpdateClaimOptions {
  readonly now: number;
  readonly leaseUntil: number;
  readonly maxAttempts: number;
  /** Keep an attempts-spent abandonment pending until the consumer acknowledges it. */
  readonly durableExhaustion?: boolean;
}

export interface TelegramUpdateDueQuery {
  readonly now: number;
  /** A `pending` record is due once received at or before this — its own process had its chance. */
  readonly pendingBefore: number;
  readonly limit: number;
}

export interface StoredTelegramUpdate {
  readonly updateId: number;
  readonly body: string;
}

/** The immutable identity of one claim, including a token that never repeats after pruning. */
export interface TelegramUpdateAttemptIdentity {
  readonly updateId: number;
  readonly attempt: number;
  readonly claimId: string;
}

/** A final failure waiting for the consumer's durable obligation. */
export interface StoredTelegramUpdateExhaustion
  extends StoredTelegramUpdate,
    TelegramUpdateAttemptIdentity {
  readonly exhaustedAt: number;
  readonly error: string;
}

/** One ordered page of final failures still waiting for acknowledgement. */
export interface TelegramUpdateExhaustionQuery {
  readonly limit: number;
  /** Continue strictly after this `update_id`; omit to begin at the first row. */
  readonly afterUpdateId?: number;
}

export interface TelegramUpdateStore {
  /** Record a received update as `pending`; `false` when this `update_id` is already recorded. */
  add(update: StoredTelegramUpdate & { readonly receivedAt: number }): Promise<boolean>;
  /** Take a claimable update for one attempt; its number, or `undefined` when not taken. */
  claim(updateId: number, options: TelegramUpdateClaimOptions): Promise<number | undefined>;
  /** Extend the lease of this attempt; `false` when the attempt no longer holds the update. */
  renew(
    updateId: number,
    attempt: number,
    leaseUntil: number,
    /** When supplied, a lease that already expired cannot be resurrected. */
    now?: number,
  ): Promise<boolean>;
  /** End this attempt; ignored when the attempt no longer holds the update. */
  settle(
    updateId: number,
    attempt: number,
    settlement: TelegramUpdateSettlement,
  ): Promise<void>;
  /** Claimable updates in `update_id` order. */
  due(query: TelegramUpdateDueQuery): Promise<readonly StoredTelegramUpdate[]>;
  /** Forget `completed` and `abandoned` updates settled before `before`; how many were forgotten. */
  prune(before: number): Promise<number>;
}

/** A store able to verify an immutable attempt fence inside the caller's transaction. */
export interface TelegramUpdateFencedStore extends TelegramUpdateStore {
  /** Atomically take one claim and return its persisted, globally unique identity. */
  claimOwned(
    updateId: number,
    options: TelegramUpdateClaimOptions,
  ): Promise<TelegramUpdateAttemptIdentity | undefined>;
  /** Extend only this exact claim's live lease. */
  renewOwned(
    identity: TelegramUpdateAttemptIdentity,
    leaseUntil: number,
    now?: number,
  ): Promise<boolean>;
  /** `true` only while this exact attempt still owns an unexpired lease. */
  owns(identity: TelegramUpdateAttemptIdentity, at: number): Promise<boolean>;
  /** Atomically settle only while this exact attempt still owns an unexpired lease. */
  settleOwned(
    identity: TelegramUpdateAttemptIdentity,
    settlement: TelegramUpdateSettlement,
  ): Promise<boolean>;
}

/**
 * The same update store with recoverable final-failure delivery.
 *
 * `exhaust` leaves the abandonment pending, `dueExhaustions` reads it after a
 * restart, and `acknowledgeExhaustion` makes it eligible for ordinary pruning.
 */
export interface TelegramUpdateDurableStore extends TelegramUpdateFencedStore {
  exhaust(
    identity: TelegramUpdateAttemptIdentity,
    exhaustion: { readonly at: number; readonly error: string },
  ): Promise<boolean>;
  dueExhaustions(
    query: TelegramUpdateExhaustionQuery,
  ): Promise<readonly StoredTelegramUpdateExhaustion[]>;
  acknowledgeExhaustion(identity: TelegramUpdateAttemptIdentity, at: number): Promise<boolean>;
}

interface MemoryRecord {
  readonly updateId: number;
  readonly body: string;
  readonly receivedAt: number;
  state: TelegramUpdateState;
  attempts: number;
  dueAt: number;
  settledAt: number | undefined;
  error: string | undefined;
  claimId: string | undefined;
}

function isClaimable(
  record: { readonly state: TelegramUpdateState; readonly dueAt: number },
  now: number,
): boolean {
  if (record.state === 'pending') return true;
  if (record.state === 'failed') return record.dueAt <= now;
  return record.state === 'processing' && record.dueAt < now;
}

/**
 * A store in this process's memory — for tests, and for a bot that accepts
 * losing what was received but not handled when it restarts.
 */
export function memoryTelegramUpdateStore(): TelegramUpdateDurableStore {
  const records = new Map<number, MemoryRecord>();
  const holding = (
    updateId: number,
    attempt: number,
    claimId?: string,
  ): MemoryRecord | undefined => {
    const record = records.get(updateId);
    return record?.state === 'processing' &&
      record.attempts === attempt &&
      (claimId === undefined || record.claimId === claimId)
      ? record
      : undefined;
  };
  const settleCurrent = (
    updateId: number,
    attempt: number,
    settlement: TelegramUpdateSettlement,
    claimId?: string,
  ): boolean => {
    const record = holding(updateId, attempt, claimId);
    if (!record || record.dueAt < settlement.at) return false;
    record.state = settlement.state;
    record.error = settlement.state === 'completed' ? undefined : settlement.error;
    if (settlement.state === 'failed') record.dueAt = settlement.retryAt;
    else record.settledAt = settlement.at;
    return true;
  };
  const claimOwned = (
    updateId: number,
    options: TelegramUpdateClaimOptions,
  ): TelegramUpdateAttemptIdentity | undefined => {
    const record = records.get(updateId);
    if (!record || !isClaimable(record, options.now)) return undefined;
    if (record.attempts >= options.maxAttempts) {
      Object.assign(record, {
        state: 'abandoned',
        dueAt: options.now,
        settledAt: options.durableExhaustion ? undefined : options.now,
        error: 'attempts spent',
        claimId: record.claimId ?? randomUUID(),
      });
      return undefined;
    }
    record.state = 'processing';
    record.attempts += 1;
    record.dueAt = options.leaseUntil;
    record.claimId = randomUUID();
    return { updateId, attempt: record.attempts, claimId: record.claimId };
  };
  return {
    async add(update) {
      if (records.has(update.updateId)) return false;
      records.set(update.updateId, {
        ...update,
        state: 'pending',
        attempts: 0,
        dueAt: update.receivedAt,
        settledAt: undefined,
        error: undefined,
        claimId: undefined,
      });
      return true;
    },
    async claim(updateId, options) {
      return claimOwned(updateId, options)?.attempt;
    },
    async claimOwned(updateId, options) {
      return claimOwned(updateId, options);
    },
    async renew(updateId, attempt, leaseUntil, at) {
      const record = holding(updateId, attempt);
      if (!record || (at !== undefined && record.dueAt < at)) return false;
      record.dueAt = Math.max(record.dueAt, leaseUntil);
      return true;
    },
    async settle(updateId, attempt, settlement) {
      settleCurrent(updateId, attempt, settlement);
    },
    async due(query) {
      return [...records.values()]
        .filter((record) =>
          record.state === 'pending'
            ? record.receivedAt <= query.pendingBefore
            : isClaimable(record, query.now),
        )
        .sort((left, right) => left.updateId - right.updateId)
        .slice(0, query.limit)
        .map(({ updateId, body }) => ({ updateId, body }));
    },
    async owns(identity, at) {
      const record = holding(identity.updateId, identity.attempt, identity.claimId);
      return record !== undefined && record.dueAt >= at;
    },
    async renewOwned(identity, leaseUntil, at) {
      const record = holding(identity.updateId, identity.attempt, identity.claimId);
      if (!record || (at !== undefined && record.dueAt < at)) return false;
      record.dueAt = Math.max(record.dueAt, leaseUntil);
      return true;
    },
    async settleOwned(identity, settlement) {
      return settleCurrent(identity.updateId, identity.attempt, settlement, identity.claimId);
    },
    async exhaust(identity, exhaustion) {
      const record = holding(identity.updateId, identity.attempt, identity.claimId);
      if (!record || record.dueAt < exhaustion.at) return false;
      Object.assign(record, {
        state: 'abandoned',
        dueAt: exhaustion.at,
        settledAt: undefined,
        error: exhaustion.error,
      });
      return true;
    },
    async dueExhaustions(query) {
      return [...records.values()]
        .filter(
          (record) =>
            record.state === 'abandoned' &&
            record.settledAt === undefined &&
            (query.afterUpdateId === undefined || record.updateId > query.afterUpdateId),
        )
        .sort((left, right) => left.updateId - right.updateId)
        .slice(0, query.limit)
        .flatMap(({ updateId, body, attempts, dueAt, error, claimId }) =>
          claimId
            ? [
                {
                  updateId,
                  body,
                  attempt: attempts,
                  claimId,
                  exhaustedAt: dueAt,
                  error: error ?? 'attempts spent',
                },
              ]
            : [],
        );
    },
    async acknowledgeExhaustion(identity, at) {
      const record = records.get(identity.updateId);
      if (
        record?.state !== 'abandoned' ||
        record.attempts !== identity.attempt ||
        record.claimId !== identity.claimId ||
        record.settledAt !== undefined
      ) {
        return false;
      }
      record.settledAt = at;
      return true;
    },
    async prune(before) {
      let pruned = 0;
      for (const [updateId, record] of records) {
        if (record.settledAt !== undefined && record.settledAt < before) {
          records.delete(updateId);
          pruned += 1;
        }
      }
      return pruned;
    },
  };
}
