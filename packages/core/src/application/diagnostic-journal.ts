import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  type DiagnosticJournal,
  type DiagnosticJournalConfig,
  DiagnosticJournalLimitsSchema,
  DiagnosticJournalLockPolicySchema,
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
 */
export async function createDiagnosticJournal<SCHEMA extends z.ZodType>(
  config: DiagnosticJournalConfig<SCHEMA>,
): Promise<DiagnosticJournal<z.input<SCHEMA>>> {
  const limits = DiagnosticJournalLimitsSchema.parse(config.limits);
  const lock = DiagnosticJournalLockPolicySchema.parse(config.lock ?? 'refuse');
  const storage = await createRotatingDiagnosticJournalStorage({
    path: config.path,
    maxFileBytes: limits.maxFileBytes,
    maxFiles: limits.maxFiles,
    mode: parseDiagnosticJournalMode(config.mode),
    lock,
  });
  return createDiagnosticJournalManager(
    {
      eventSchema: config.eventSchema,
      epoch: randomUUID(),
      limits,
      lock: { policy: lock, reclaimedStale: storage.reclaimedStale },
      ...(config.onFailure && { onFailure: config.onFailure }),
    },
    storage,
  );
}
