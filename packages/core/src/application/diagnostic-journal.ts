import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  type DiagnosticJournal,
  type DiagnosticJournalConfig,
  DiagnosticJournalLimitsSchema,
  parseDiagnosticJournalMode,
} from './diagnostic-journal-contract';
import { createDiagnosticJournalManager } from './diagnostic-journal-manager';
import { createRotatingDiagnosticJournalStorage } from './diagnostic-journal-storage';

/**
 * One process-local ordered JSONL diagnostic journal.
 *
 * `flush()` observes completed append calls, not an fsync or durable-delivery receipt. One live
 * manager exclusively owns the injected path; an abrupt process death may leave its `.lock` file
 * for an operator to remove only after proving the previous owner is gone.
 */
export async function createDiagnosticJournal<SCHEMA extends z.ZodType>(
  config: DiagnosticJournalConfig<SCHEMA>,
): Promise<DiagnosticJournal<z.input<SCHEMA>>> {
  const limits = DiagnosticJournalLimitsSchema.parse(config.limits);
  const storage = await createRotatingDiagnosticJournalStorage({
    path: config.path,
    maxFileBytes: limits.maxFileBytes,
    maxFiles: limits.maxFiles,
    mode: parseDiagnosticJournalMode(config.mode),
  });
  return createDiagnosticJournalManager(
    {
      eventSchema: config.eventSchema,
      epoch: randomUUID(),
      limits,
      ...(config.onFailure && { onFailure: config.onFailure }),
    },
    storage,
  );
}
