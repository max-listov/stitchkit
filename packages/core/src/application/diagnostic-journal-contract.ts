import { z } from 'zod';
import { isRecord } from '../internal/typed';

const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const FileModeSchema = z.number().int().min(0).max(0o777);

export const DiagnosticJournalLimitsSchema = z
  .object({
    maxEventBytes: PositiveSafeIntegerSchema,
    maxPendingItems: PositiveSafeIntegerSchema,
    maxPendingBytes: PositiveSafeIntegerSchema,
    maxFileBytes: PositiveSafeIntegerSchema,
    maxFiles: PositiveSafeIntegerSchema,
  })
  .strict()
  .readonly();
export type DiagnosticJournalLimits = z.infer<typeof DiagnosticJournalLimitsSchema>;

export const DiagnosticJournalLockPolicySchema = z.enum(['refuse', 'reclaim-stale']);
export type DiagnosticJournalLockPolicy = z.infer<typeof DiagnosticJournalLockPolicySchema>;

export const DiagnosticJournalStateSchema = z.enum(['open', 'draining', 'closed', 'failed']);
export type DiagnosticJournalState = z.infer<typeof DiagnosticJournalStateSchema>;

export const DiagnosticJournalRefusalReasonSchema = z.enum([
  'closed',
  'failed',
  'invalid',
  'oversized',
  'item-capacity',
  'byte-capacity',
]);
export type DiagnosticJournalRefusalReason = z.infer<
  typeof DiagnosticJournalRefusalReasonSchema
>;

const DiagnosticJournalRefusalCountersSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    oversized: z.number().int().nonnegative(),
    'item-capacity': z.number().int().nonnegative(),
    'byte-capacity': z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const DiagnosticJournalFailurePhaseSchema = z.enum(['write', 'rotation', 'close']);
export type DiagnosticJournalFailurePhase = z.infer<
  typeof DiagnosticJournalFailurePhaseSchema
>;

export const DiagnosticJournalStatusSchema = z
  .object({
    state: DiagnosticJournalStateSchema,
    epoch: z.uuid(),
    limits: DiagnosticJournalLimitsSchema,
    lock: z
      .object({
        policy: DiagnosticJournalLockPolicySchema,
        /** This journal started by reclaiming a lock whose owner was provably gone. */
        reclaimedStale: z.boolean(),
      })
      .strict()
      .readonly(),
    received: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    refusals: DiagnosticJournalRefusalCountersSchema,
    written: z.number().int().nonnegative(),
    failedRecords: z.number().int().nonnegative(),
    pendingItems: z.number().int().nonnegative(),
    pendingBytes: z.number().int().nonnegative(),
    inFlight: z.boolean(),
    rotations: z.number().int().nonnegative(),
    rotationFailures: z.number().int().nonnegative(),
    partialTails: z.number().int().nonnegative(),
    currentFileBytes: z.number().int().nonnegative(),
    retainedFiles: z.number().int().nonnegative(),
    lastAcceptedSequence: z.number().int().positive().optional(),
    lastWrittenSequence: z.number().int().positive().optional(),
    lastSettledSequence: z.number().int().positive().optional(),
    lastFailure: z
      .object({
        phase: DiagnosticJournalFailurePhaseSchema,
        sequence: z.number().int().positive().optional(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type DiagnosticJournalStatus = z.infer<typeof DiagnosticJournalStatusSchema>;

export const DiagnosticJournalSubmitResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('accepted'),
      epoch: z.uuid(),
      sequence: z.number().int().positive(),
    })
    .strict()
    .readonly(),
  z
    .object({
      outcome: z.literal('refused'),
      reason: DiagnosticJournalRefusalReasonSchema,
    })
    .strict()
    .readonly(),
]);
export type DiagnosticJournalSubmitResult = z.infer<
  typeof DiagnosticJournalSubmitResultSchema
>;

export const DiagnosticJournalWaitResultSchema = z
  .object({
    outcome: z.enum(['settled', 'timed-out', 'cancelled']),
    state: DiagnosticJournalStateSchema,
    throughSequence: z.number().int().nonnegative(),
    settledSequence: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type DiagnosticJournalWaitResult = z.infer<typeof DiagnosticJournalWaitResultSchema>;

export const DiagnosticJournalCloseResultSchema = z
  .object({
    outcome: z.enum(['closed', 'timed-out', 'cancelled']),
    state: DiagnosticJournalStateSchema,
    pendingItems: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type DiagnosticJournalCloseResult = z.infer<typeof DiagnosticJournalCloseResultSchema>;

export const DiagnosticJournalFrameSchema = z
  .object({
    schemaVersion: z.literal(1),
    epoch: z.uuid(),
    sequence: z.number().int().positive(),
    event: z.json(),
  })
  .strict()
  .readonly();
export type DiagnosticJournalFrame = z.infer<typeof DiagnosticJournalFrameSchema>;

export interface DiagnosticJournalWaitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface DiagnosticJournalFailure {
  readonly phase: DiagnosticJournalFailurePhase;
  readonly error: unknown;
  readonly sequence?: number;
}

export interface DiagnosticJournalConfig<SCHEMA extends z.ZodType> {
  readonly eventSchema: SCHEMA;
  /** Absolute operator-owned file path. Event data can never select it. */
  readonly path: string;
  readonly limits: DiagnosticJournalLimits;
  /** Created file and lock permissions. Default `0o600`. */
  readonly mode?: number;
  /**
   * What to do about a lock that is already present. Default `refuse`.
   *
   * `reclaim-stale` reclaims it only when the recorded owner is provably gone — a liveness
   * check, never an age heuristic, because a slow writer and a dead one are indistinguishable
   * by time and the lock exists for exactly that case.
   */
  readonly lock?: DiagnosticJournalLockPolicy;
  /**
   * This machine's stable identity, overriding platform detection.
   *
   * The lock records it so a machine that renames itself is still recognised as itself — a host
   * name is mutable state, and treating it as identity left a renamed machine unable to reclaim
   * its own abandoned lock. Detection covers `/etc/machine-id` and the macOS platform UUID; state
   * it here on a platform that offers neither, or when the deployment knows better. It must be
   * stable across restarts and distinct per machine: a value shared by two machines is the one
   * mistake this guard exists to prevent.
   */
  readonly machineIdentity?: string;
  /** Diagnostics are isolated and are never written back into this journal. */
  readonly onFailure?: (failure: DiagnosticJournalFailure) => void | Promise<void>;
}

export interface DiagnosticJournal<INPUT> {
  /** Synchronous validation, serialization and bounded in-memory admission. */
  submit(event: INPUT): DiagnosticJournalSubmitResult;
  /** Wait for accepted records through this call's boundary; this is not an fsync guarantee. */
  flush(options?: DiagnosticJournalWaitOptions): Promise<DiagnosticJournalWaitResult>;
  getStatus(): DiagnosticJournalStatus;
  /** Stop admission and wait within the caller budget; physical cleanup continues after timeout. */
  close(options?: DiagnosticJournalWaitOptions): Promise<DiagnosticJournalCloseResult>;
}

export function parseDiagnosticJournalMode(mode: number | undefined): number {
  return FileModeSchema.parse(mode ?? 0o600);
}

/*
 * The lock diagnosis lives with the contract, not with the lock.
 *
 * It is a shape a consumer reads and a pure projection off a thrown value — no
 * file handle, no spawn, nothing from `node:`. Exporting it from the lock module
 * pulled that whole module into the published declarations, and with it
 * `AcquiredDiagnosticJournalLock`, whose `handle` is typed off `node:fs/promises`
 * `open`. A consumer without Node types then cannot resolve the package's own
 * `.d.ts`, which the consumer lane caught as a reference it could not settle.
 */

/** Why a present lock was not reclaimed. Attached to the thrown `EEXIST`, never thrown itself. */
export interface DiagnosticJournalLockDiagnosis {
  readonly attribution: 'this-machine' | 'another-machine' | 'unattributable';
  readonly liveness: 'alive' | 'gone' | 'not-probed';
  readonly owner: { pid: number; host: string; acquiredAt: string; machine?: string } | null;
}

/** Read the diagnosis a refused acquisition attached to its error, if it carried one. */
export function readDiagnosticJournalLockDiagnosis(
  error: unknown,
): DiagnosticJournalLockDiagnosis | undefined {
  if (!isRecord(error)) return undefined;
  const diagnosis = error.journalLock;
  return isRecord(diagnosis)
    ? (diagnosis as unknown as DiagnosticJournalLockDiagnosis)
    : undefined;
}
