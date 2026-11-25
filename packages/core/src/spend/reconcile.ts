import { isRecord, withoutUndefined } from '../internal/typed';
import { mergeSpendReceipt } from './receipt-merge';
import {
  type SpendFacts,
  SpendFactsSchema,
  type SpendLedgerStore,
  type SpendReceipt,
  type SpendRecord,
} from './schemas';

/**
 * Ask one provider what an attempt cost, after the fact (OpenRouter's
 * `GET /api/v1/generation?id=`). `undefined` — not known yet, try again later;
 * facts with `costStatus: 'unknown'` — it will not be known, stop asking.
 */
export type SpendReconciler = (
  record: SpendRecord,
) => Promise<Partial<SpendFacts> | undefined>;

/** The ledger and the per-gateway reconcilers of one reconciliation pass. */
export interface ReconcilePendingSpendOptions {
  store: SpendLedgerStore;
  /** By gateway name; a pending attempt of a gateway without one is left as it is. */
  reconcilers: Readonly<Record<string, SpendReconciler>>;
  limit?: number;
  now?: () => Date;
  /** A reconciler that threw or returned invalid facts: the attempt stays pending, and here is why (for `reconcileError`). */
  onError?: (failure: { record: SpendRecord; error: unknown }) => void;
}

/** What one reconciliation pass did: checked, reconciled, still pending, failed. */
export interface SpendReconcileResult {
  checked: number;
  reconciled: number;
  stillPending: number;
  failed: number;
}

/**
 * One pass over the attempts whose cost is still `pending`: each reconciler's
 * answer is settled as a rank-3 receipt, merged so it only ever adds what the
 * provider now knows. A reconciler that throws or returns invalid facts is
 * counted and its attempt stays pending for the next pass.
 */
export async function reconcilePendingSpend(
  options: ReconcilePendingSpendOptions,
): Promise<SpendReconcileResult> {
  const { store } = options;
  if (!store.pendingCosts)
    throw new TypeError('reconcilePendingSpend needs a store with pendingCosts');
  const now = options.now ?? (() => new Date());
  const result: SpendReconcileResult = {
    checked: 0,
    reconciled: 0,
    stillPending: 0,
    failed: 0,
  };
  for (const record of await store.pendingCosts({ limit: options.limit ?? 100 })) {
    result.checked += 1;
    const reconcile = options.reconcilers[record.attempt.gateway];
    if (!reconcile) {
      result.stillPending += 1;
      continue;
    }
    let receipt: SpendReceipt;
    try {
      const learned = await reconcile(record);
      if (learned === undefined) {
        result.stillPending += 1;
        continue;
      }
      if (!isRecord(learned)) {
        throw new TypeError('Spend reconciler must return a facts object or undefined');
      }
      receipt = mergeSpendReceipt(record.receipt, {
        attemptId: record.attempt.attemptId,
        rank: 3,
        at: now().toISOString(),
        outcome: record.receipt?.outcome ?? 'pending',
        facts: SpendFactsSchema.parse({ costStatus: 'unknown', ...withoutUndefined(learned) }),
      });
    } catch (error) {
      result.failed += 1;
      options.onError?.({ record, error });
      continue;
    }
    await store.settle(receipt);
    result.reconciled += 1;
  }
  return result;
}

/**
 * Close attempts nobody closed: their process died between the call and its
 * receipt. Each becomes `orphaned` with an `unknown` cost — never a guessed zero.
 */
export async function closeOrphanedSpend(options: {
  store: SpendLedgerStore;
  olderThanMs: number;
  limit?: number;
  now?: () => Date;
}): Promise<number> {
  const { store } = options;
  if (!store.openAttempts)
    throw new TypeError('closeOrphanedSpend needs a store with openAttempts');
  const now = (options.now ?? (() => new Date()))();
  const open = await store.openAttempts({
    startedBefore: new Date(now.getTime() - options.olderThanMs).toISOString(),
    limit: options.limit ?? 100,
  });
  for (const attempt of open)
    await store.settle({
      attemptId: attempt.attemptId,
      rank: 1,
      at: now.toISOString(),
      outcome: 'orphaned',
      facts: { costStatus: 'unknown', failureCode: 'orphaned' },
    });
  return open.length;
}
