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
 *   one that took it over.
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

export interface TelegramUpdateStore {
  /** Record a received update as `pending`; `false` when this `update_id` is already recorded. */
  add(update: StoredTelegramUpdate & { readonly receivedAt: number }): Promise<boolean>;
  /** Take a claimable update for one attempt; its number, or `undefined` when not taken. */
  claim(updateId: number, options: TelegramUpdateClaimOptions): Promise<number | undefined>;
  /** Extend the lease of this attempt; `false` when the attempt no longer holds the update. */
  renew(updateId: number, attempt: number, leaseUntil: number): Promise<boolean>;
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

interface MemoryRecord {
  readonly updateId: number;
  readonly body: string;
  readonly receivedAt: number;
  state: TelegramUpdateState;
  attempts: number;
  dueAt: number;
  settledAt: number | undefined;
  error: string | undefined;
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
export function memoryTelegramUpdateStore(): TelegramUpdateStore {
  const records = new Map<number, MemoryRecord>();
  const holding = (updateId: number, attempt: number): MemoryRecord | undefined => {
    const record = records.get(updateId);
    return record?.state === 'processing' && record.attempts === attempt ? record : undefined;
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
      });
      return true;
    },
    async claim(updateId, options) {
      const record = records.get(updateId);
      if (!record || !isClaimable(record, options.now)) return undefined;
      if (record.attempts >= options.maxAttempts) {
        Object.assign(record, {
          state: 'abandoned',
          settledAt: options.now,
          error: 'attempts spent',
        });
        return undefined;
      }
      record.state = 'processing';
      record.attempts += 1;
      record.dueAt = options.leaseUntil;
      return record.attempts;
    },
    async renew(updateId, attempt, leaseUntil) {
      const record = holding(updateId, attempt);
      if (record) record.dueAt = leaseUntil;
      return record !== undefined;
    },
    async settle(updateId, attempt, settlement) {
      const record = holding(updateId, attempt);
      if (!record) return;
      record.state = settlement.state;
      record.error = settlement.state === 'completed' ? undefined : settlement.error;
      if (settlement.state === 'failed') record.dueAt = settlement.retryAt;
      else record.settledAt = settlement.at;
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
