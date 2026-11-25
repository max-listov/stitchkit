import { z } from 'zod';
import {
  createSpoolCore,
  type SpoolRecovery,
  SpoolUnspooledError,
} from '../observability/spool-core';
import {
  type SpendAttempt,
  SpendAttemptSchema,
  type SpendLedgerStore,
  type SpendReceipt,
  SpendReceiptSchema,
} from './schemas';

const SpooledSpendSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('begin'), attempt: SpendAttemptSchema }),
  z.strictObject({ type: z.literal('settle'), receipt: SpendReceiptSchema }),
]);
type SpooledSpend = z.infer<typeof SpooledSpendSchema>;

/** The ledger a spool sits in front of, its file and its bounds. */
export interface SpooledSpendStoreConfig {
  /** The ledger the records belong in, normally the application's database. */
  store: SpendLedgerStore;
  /** The spool file; one process, one path. Created `0o600` with its directory. */
  path: string;
  maxPendingEntries?: number;
  maxFileBytes?: number;
  onSpoolError?: (failure: { error: unknown }) => void;
}

/** A ledger whose writes reach disk before the database, with `recover` for what an earlier process left. */
export interface SpooledSpendStore extends SpendLedgerStore {
  /**
   * Replay what an earlier process left undelivered, in the order it was written —
   * an attempt before its receipts — stopping at the first refusal. Call once at
   * startup, before the gateway is used.
   */
  recover(): Promise<SpoolRecovery>;
  pending(): number;
}

/**
 * A ledger that survives its database being down: every attempt and receipt is
 * on disk before the database is offered it. A write the database refuses still
 * resolves once the record is spooled — the call it accounts for goes ahead — and
 * `recover` delivers it at the next start. A receipt whose attempt is still
 * undelivered waits on disk with it, so the database never sees a receipt ahead
 * of its attempt. Only a record that could be neither spooled nor stored
 * rejects, so the gateway refuses a call nothing would account for.
 */
export function createSpooledSpendStore(config: SpooledSpendStoreConfig): SpooledSpendStore {
  const spool = createSpoolCore<SpooledSpend>({
    path: config.path,
    key: (record) =>
      record.type === 'begin'
        ? `begin:${record.attempt.attemptId}`
        : `settle:${record.receipt.attemptId}:${record.receipt.rank}:${record.receipt.at}`,
    // One attempt's records reach the database in order: never a receipt ahead of its attempt.
    group: (record) =>
      record.type === 'begin' ? record.attempt.attemptId : record.receipt.attemptId,
    write: (record) =>
      record.type === 'begin'
        ? config.store.begin(record.attempt)
        : config.store.settle(record.receipt),
    encode: (record) => record,
    decode: (value) => SpooledSpendSchema.parse(value),
    ...(config.maxPendingEntries !== undefined && {
      maxPendingEntries: config.maxPendingEntries,
    }),
    ...(config.maxFileBytes !== undefined && { maxFileBytes: config.maxFileBytes }),
    ...(config.onSpoolError && {
      onSpoolError: ({ error }) => config.onSpoolError?.({ error }),
    }),
  });
  const write = async (record: SpooledSpend) => {
    const result = await spool.write(record);
    if (result.outcome === 'unspooled') throw new SpoolUnspooledError(result.storeError);
  };
  return {
    begin: (attempt: SpendAttempt) =>
      write({ type: 'begin', attempt: SpendAttemptSchema.parse(attempt) }),
    settle: (receipt: SpendReceipt) =>
      write({ type: 'settle', receipt: SpendReceiptSchema.parse(receipt) }),
    ...(config.store.pendingCosts && {
      pendingCosts: (input: { limit: number }) =>
        config.store.pendingCosts?.(input) ?? Promise.resolve([]),
    }),
    ...(config.store.openAttempts && {
      openAttempts: (input: { startedBefore: string; limit: number }) =>
        config.store.openAttempts?.(input) ?? Promise.resolve([]),
    }),
    recover: () => spool.recover(),
    pending: () => spool.pending(),
  };
}
