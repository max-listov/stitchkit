import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  type DiagnosticJournal,
  type DiagnosticJournalConfig,
  DiagnosticJournalLimitsSchema,
  DiagnosticJournalLockPolicySchema,
  DiagnosticJournalStartupRefusalPolicySchema,
  DiagnosticJournalStartupScanSchema,
  parseDiagnosticJournalMode,
} from './diagnostic-journal-contract';
import { createDiagnosticJournalManager } from './diagnostic-journal-manager';
import { createRotatingDiagnosticJournalStorage } from './diagnostic-journal-storage';

/**
 * One process-local ordered JSONL diagnostic journal.
 *
 * `flush()` observes completed append calls, not an fsync or durable-delivery receipt. One live
 * manager exclusively owns the injected path; an abrupt process death leaves its `.lock` file
 * behind. By default an operator removes it after proving the previous owner is gone; `lock:
 * 'reclaim-stale'` makes the journal prove that itself, which is what an unattended service
 * restarted by its supervisor needs.
 *
 * Opening moves a file it cannot keep in place aside and starts (`onStartupRefusal`, default
 * `quarantine`); `getStatus().recovery` names what it found and moved.
 */
export async function createDiagnosticJournal<SCHEMA extends z.ZodType>(
  config: DiagnosticJournalConfig<SCHEMA>,
): Promise<DiagnosticJournal<z.input<SCHEMA>>> {
  const limits = DiagnosticJournalLimitsSchema.parse(config.limits);
  const lock = DiagnosticJournalLockPolicySchema.parse(config.lock ?? 'refuse');
  const epoch = randomUUID();
  const storage = await createRotatingDiagnosticJournalStorage({
    path: config.path,
    maxFileBytes: limits.maxFileBytes,
    maxFiles: limits.maxFiles,
    mode: parseDiagnosticJournalMode(config.mode),
    lock,
    scan: DiagnosticJournalStartupScanSchema.parse(config.startupScan ?? 'tails'),
    onStartupRefusal: DiagnosticJournalStartupRefusalPolicySchema.parse(
      config.onStartupRefusal ?? 'quarantine',
    ),
    epoch,
    ...(config.machineIdentity !== undefined && { machineIdentity: config.machineIdentity }),
  });
  return createDiagnosticJournalManager(
    {
      eventSchema: config.eventSchema,
      epoch,
      limits,
      lock: { policy: lock, reclaimedStale: storage.reclaimedStale },
      ...(config.onFailure && { onFailure: config.onFailure }),
    },
    storage,
  );
}
