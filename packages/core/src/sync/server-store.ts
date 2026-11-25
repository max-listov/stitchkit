/**
 * The server half of a sync: version numbers, a ledger of applied changes and
 * a feed of what changed — one owner for each, behind the application's own
 * transaction.
 *
 * - **Versions.** Every writer of a stream takes its numbers from
 *   `allocateVersions` inside its transaction. The counter is a row locked
 *   until commit, so transactions commit in the order of their numbers: a
 *   reader that saw version 7 never later finds a 6 committed behind it. A
 *   sequence would hand out numbers without that order.
 * - **Ledger.** A change is identified by `(scope, replicaId, changeId)`. A
 *   repeat with the same content gets the stored outcome without running the
 *   change again; the same id with other content is refused. A change the app
 *   rejected is recorded too, so its repeat is rejected the same way; a change
 *   that threw is not — its transaction rolled back, and a repeat runs it.
 * - **Feed.** One row per entity — its newest version and whether it is
 *   deleted — so the feed grows with the entities, not with the edits. A full
 *   read returns only live entities.
 *
 * The app keeps its own tables and its own merge; the store only numbers,
 * remembers and lists.
 */
import { createHash } from 'node:crypto';
import { serializeCanonicalJson } from '../internal/canonical-json';
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
} from '../internal/positive-integer';
import type { SyncChangeOutcome } from './protocol';

/** One entity the feed lists: its newest version and whether it is gone. */
export interface SyncFeedEntry {
  readonly entity: string;
  readonly entityId: string;
  readonly deleted: boolean;
}

/** Versioned feed entry recording an entity's latest version and deletion state. */
export interface SyncFeedChange extends SyncFeedEntry {
  readonly version: number;
}

/** One paginated slice of the server sync feed along with cursor and latest version metadata. */
export interface SyncFeedPage {
  readonly changes: readonly SyncFeedChange[];
  readonly hasMore: boolean;
  /** The cursor of the next page; `null` at the end. */
  readonly nextCursor: number | null;
  /** The newest version of the scope when the page was read; `0` before any. */
  readonly latestVersion: number;
}

/** Pagination and full-snapshot options passed when reading changes from the sync feed. */
export interface SyncFeedRead {
  /** At most this many changes; a positive integer. */
  readonly limit: number;
  /** A full snapshot: live entities only. */
  readonly full?: boolean;
}

/**
 * What the app decided about one change. A rejection rolls back whatever `apply`
 * wrote and is recorded on its own; a throw is neither — it rolls back, is not
 * recorded, and is `retryable_failed`.
 */
export type SyncApplyDecision<EFFECT> =
  /** `effect`, when given, comes back from `push` after the commit, for the caller to emit. */
  | { readonly outcome: 'applied'; readonly effect?: EFFECT }
  | { readonly outcome: 'terminal_rejected'; readonly code: string };

/** Application callback that applies one pushed change inside caller transaction `TX`. */
export type SyncApply<TX, CHANGE, EFFECT> = (
  tx: TX,
  change: CHANGE,
) => Promise<SyncApplyDecision<EFFECT>>;

/** Batch of client changes pushed under a scope and authenticated replica identity. */
export interface SyncPushRequest<CHANGE extends { readonly id: string }> {
  readonly scope: string;
  /** The replica the authentication names. */
  readonly replicaId: string;
  /** The replica the request claims; a mismatch rejects every change, unrun. */
  readonly claimedReplicaId?: string;
  readonly changes: readonly CHANGE[];
}

/** Per-change wire result returned from a server sync push operation. */
export interface SyncPushChangeResult {
  readonly changeId: string;
  readonly outcome: SyncChangeOutcome;
  readonly code?: string;
  /**
   * The newest version the change's transaction took, on `applied` and `replayed`;
   * the client keeps its row confirmed until its cursor covers it. Absent when the
   * change published nothing.
   */
  readonly version?: number;
}

/** Aggregate outcome of a server sync push, separating client results, effects, and internal errors. */
export interface SyncPushOutcome<EFFECT> {
  /** One result per change, in order — what goes back to the client. */
  readonly results: readonly SyncPushChangeResult[];
  /** Effects of the changes applied now, in order, after their commits — for the caller to emit. */
  readonly effects: readonly EFFECT[];
  /**
   * Why each `retryable_failed` change failed — a throw of `apply`, the driver or
   * the commit. For the server's log; never send it to the client.
   */
  readonly failures: readonly { readonly changeId: string; readonly error: unknown }[];
}

/** One ledger record: the content's fingerprint and the outcome it got. */
export interface SyncLedgerRecord {
  readonly fingerprint: string;
  readonly outcome: 'applied' | 'terminal_rejected';
  readonly code: string | null;
  /** The newest version an applied change took; `null` when it took none, or was rejected. */
  readonly version: number | null;
  readonly recordedAt: number;
}

/** Composite `(scope, replicaId, changeId)` key identifying one idempotent ledger record. */
export interface SyncLedgerKey {
  readonly scope: string;
  readonly replicaId: string;
  readonly changeId: string;
}

/** Which ledger records `prune` forgets. */
export interface SyncPrune {
  /** Records older than this, in ms since the epoch. */
  readonly before: number;
  /** Only this scope's records; every scope when omitted. */
  readonly scope?: string;
}

/** What a store implements; `createSyncServerStore` builds the rules on top once. */
export interface SyncStoreBackend<TX> {
  transaction<T>(work: (tx: TX) => Promise<T>): Promise<T>;
  allocateVersions(tx: TX, scope: string, count: number): Promise<readonly number[]>;
  upsertFeed(tx: TX, scope: string, changes: readonly SyncFeedChange[]): Promise<void>;
  readLedger(tx: TX, key: SyncLedgerKey): Promise<SyncLedgerRecord | undefined>;
  writeLedger(tx: TX, key: SyncLedgerKey, record: SyncLedgerRecord): Promise<void>;
  changesAfter(scope: string, after: number | null, read: SyncFeedRead): Promise<SyncFeedPage>;
  prune(prune: SyncPrune): Promise<number>;
}

/** Server-side sync store managing version counters, change ledger, and entity feed. */
export interface SyncServerStore<TX> {
  /** The application's transaction; every method taking `tx` runs inside it. */
  transaction<T>(work: (tx: TX) => Promise<T>): Promise<T>;
  /** `count` consecutive versions of `scope`, held in order until `tx` commits. */
  allocateVersions(tx: TX, scope: string, count: number): Promise<readonly number[]>;
  /** Number these entities and list them in the feed; returns their versions, in order. */
  publish(
    tx: TX,
    scope: string,
    entries: readonly SyncFeedEntry[],
  ): Promise<readonly number[]>;
  /**
   * Run each change once, in its own transaction, by the ledger. Not inside
   * `transaction`: each change commits on its own.
   */
  push<CHANGE extends { readonly id: string }, EFFECT>(
    request: SyncPushRequest<CHANGE>,
    apply: SyncApply<TX, CHANGE, EFFECT>,
  ): Promise<SyncPushOutcome<EFFECT>>;
  changesAfter(scope: string, after: number | null, read: SyncFeedRead): Promise<SyncFeedPage>;
  /** Forget old ledger records; a repeat of a forgotten change runs again. */
  prune(prune: SyncPrune): Promise<number>;
}

/** The fingerprint of a change: SHA-256 over its canonical JSON. */
export function syncChangeFingerprint(change: unknown): string {
  return createHash('sha256').update(serializeCanonicalJson(change)).digest('hex');
}

function checkedRead(after: number | null, read: SyncFeedRead): void {
  assertPositiveSafeInteger('[stitchkit] sync: a feed limit', read.limit, RangeError, {
    absent: 'refused',
  });
  if (after !== null)
    assertNonNegativeSafeInteger('[stitchkit] sync: a feed cursor', after, RangeError, {
      absent: 'refused',
    });
}

/** Rolls an `apply` that rejected back; its rejection is recorded on its own. */
class Rejected {
  constructor(readonly code: string) {}
}

type PushOne<EFFECT> = {
  readonly result: SyncPushChangeResult;
  readonly effect?: EFFECT;
  readonly error?: { readonly cause: unknown };
};

const rejected = (changeId: string, code: string): PushOne<never> => ({
  result: { changeId, outcome: 'terminal_rejected', code },
});

/** An applied or replayed result, with the version the change took when it took one. */
const answered = (
  changeId: string,
  outcome: 'applied' | 'replayed',
  version: number | null,
): SyncPushChangeResult => ({ changeId, outcome, ...(version !== null && { version }) });

/** Wrap a `SyncStoreBackend` with canonical fingerprinting, ledger replay, and validation rules. */
export function createSyncServerStore<TX>(
  backend: SyncStoreBackend<TX>,
  options: { readonly now?: () => number } = {},
): SyncServerStore<TX> {
  const now = options.now ?? Date.now;
  // The newest version each pushed change's transaction took, while its `apply` runs.
  const taking = new Map<TX, { last: number | null }>();
  const allocateVersions = async (tx: TX, scope: string, count: number) => {
    assertNonNegativeSafeInteger('[stitchkit] sync: a version count', count, RangeError, {
      absent: 'refused',
    });
    if (count === 0) return [];
    const versions = await backend.allocateVersions(tx, scope, count);
    const taken = taking.get(tx);
    const last = versions.at(-1);
    if (taken && last !== undefined) taken.last = Math.max(taken.last ?? last, last);
    return versions;
  };
  const publish = async (tx: TX, scope: string, entries: readonly SyncFeedEntry[]) => {
    const versions = await allocateVersions(tx, scope, entries.length);
    await backend.upsertFeed(
      tx,
      scope,
      entries.map((entry, index) => ({ ...entry, version: versions[index] ?? 0 })),
    );
    return versions;
  };
  /** The outcome already recorded for this key, or `undefined` when there is none. */
  const recordedOutcome = async (
    tx: TX,
    key: SyncLedgerKey,
    fingerprint: string,
  ): Promise<PushOne<never> | undefined> => {
    const recorded = await backend.readLedger(tx, key);
    if (!recorded) return undefined;
    if (recorded.fingerprint !== fingerprint)
      return rejected(key.changeId, 'change_id_reused');
    return recorded.outcome === 'applied'
      ? { result: answered(key.changeId, 'replayed', recorded.version) }
      : rejected(key.changeId, recorded.code ?? '');
  };
  const pushOne = async <CHANGE extends { readonly id: string }, EFFECT>(
    request: SyncPushRequest<CHANGE>,
    change: CHANGE,
    apply: SyncApply<TX, CHANGE, EFFECT>,
  ): Promise<PushOne<EFFECT>> => {
    const key = { scope: request.scope, replicaId: request.replicaId, changeId: change.id };
    const fingerprint = syncChangeFingerprint(change);
    try {
      return await backend.transaction(async (tx): Promise<PushOne<EFFECT>> => {
        const recorded = await recordedOutcome(tx, key, fingerprint);
        if (recorded) return recorded;
        const taken: { last: number | null } = { last: null };
        taking.set(tx, taken);
        let decision: SyncApplyDecision<EFFECT>;
        try {
          decision = await apply(tx, change);
        } finally {
          taking.delete(tx);
        }
        if (decision.outcome === 'terminal_rejected') throw new Rejected(decision.code);
        await backend.writeLedger(tx, key, {
          fingerprint,
          outcome: 'applied',
          code: null,
          version: taken.last,
          recordedAt: now(),
        });
        return {
          result: answered(change.id, 'applied', taken.last),
          ...(decision.effect !== undefined && { effect: decision.effect }),
        };
      });
    } catch (error) {
      if (!(error instanceof Rejected))
        return {
          result: { changeId: change.id, outcome: 'retryable_failed' },
          error: { cause: error },
        };
      // The rejected work rolled back; the rejection is recorded in a transaction
      // of its own, unless a concurrent push recorded this change meanwhile.
      try {
        return await backend.transaction(async (tx) => {
          const recorded = await recordedOutcome(tx, key, fingerprint);
          if (recorded) return recorded;
          await backend.writeLedger(tx, key, {
            fingerprint,
            outcome: 'terminal_rejected',
            code: error.code,
            version: null,
            recordedAt: now(),
          });
          return rejected(change.id, error.code);
        });
      } catch (recordError) {
        return {
          result: { changeId: change.id, outcome: 'retryable_failed' },
          error: { cause: recordError },
        };
      }
    }
  };
  return {
    transaction: (work) => backend.transaction(work),
    allocateVersions,
    publish,
    async push<CHANGE extends { readonly id: string }, EFFECT>(
      request: SyncPushRequest<CHANGE>,
      apply: SyncApply<TX, CHANGE, EFFECT>,
    ): Promise<SyncPushOutcome<EFFECT>> {
      if (
        request.claimedReplicaId !== undefined &&
        request.claimedReplicaId !== request.replicaId
      )
        return {
          results: request.changes.map(
            (change) => rejected(change.id, 'replica_mismatch').result,
          ),
          effects: [],
          failures: [],
        };
      const results: SyncPushChangeResult[] = [];
      const effects: EFFECT[] = [];
      const failures: { changeId: string; error: unknown }[] = [];
      for (const change of request.changes) {
        const one = await pushOne(request, change, apply);
        results.push(one.result);
        if (one.effect !== undefined) effects.push(one.effect);
        if (one.error) failures.push({ changeId: change.id, error: one.error.cause });
      }
      return { results, effects, failures };
    },
    changesAfter: (scope, after, read) => {
      checkedRead(after, read);
      return backend.changesAfter(scope, after, read);
    },
    prune: (prune) => {
      if (!Number.isFinite(prune.before))
        throw new RangeError('[stitchkit] sync: prune needs a finite `before`');
      return backend.prune(prune);
    },
  };
}
