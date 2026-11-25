import {
  mergeSpendReceipt,
  type SpendAttempt,
  type SpendLedgerStore,
  type SpendReceipt,
  type SpendRecord,
} from '../../src/entrypoints/spend';

/** An in-memory ledger with the merge rule a database would apply, and a way to await a close. */
export function memorySpendLedger() {
  const attempts = new Map<string, SpendAttempt>();
  const receipts = new Map<string, SpendReceipt>();
  const waiting = new Map<string, Array<(receipt: SpendReceipt) => void>>();
  const order: string[] = [];
  let down = false;
  const store: SpendLedgerStore = {
    async begin(attempt) {
      if (down) throw new Error('database unreachable');
      order.push(`begin:${attempt.attemptId}`);
      attempts.set(attempt.attemptId, attempt);
    },
    async settle(receipt) {
      if (down) throw new Error('database unreachable');
      order.push(`settle:${receipt.attemptId}`);
      const merged = mergeSpendReceipt(receipts.get(receipt.attemptId), receipt);
      receipts.set(receipt.attemptId, merged);
      for (const resolve of waiting.get(receipt.attemptId) ?? []) resolve(merged);
      waiting.delete(receipt.attemptId);
    },
    async pendingCosts({ limit }) {
      const records: SpendRecord[] = [];
      for (const [id, attempt] of attempts) {
        const receipt = receipts.get(id);
        if (receipt?.facts.costStatus === 'pending') records.push({ attempt, receipt });
      }
      return records.slice(0, limit);
    },
    async openAttempts({ startedBefore, limit }) {
      return [...attempts.values()]
        .filter(
          (attempt) => !receipts.has(attempt.attemptId) && attempt.startedAt < startedBefore,
        )
        .slice(0, limit);
    },
  };
  return {
    store,
    attempts,
    receipts,
    order,
    setDown(value: boolean) {
      down = value;
    },
    settled(attemptId: string): Promise<SpendReceipt> {
      const known = receipts.get(attemptId);
      if (known && known.outcome !== 'pending') return Promise.resolve(known);
      return new Promise((resolve) => {
        waiting.set(attemptId, [...(waiting.get(attemptId) ?? []), resolve]);
      });
    },
  };
}
