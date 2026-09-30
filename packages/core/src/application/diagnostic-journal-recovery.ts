import { z } from 'zod';
import {
  type DiagnosticJournalAnomaly,
  type DiagnosticJournalRecoveryStatus,
  DiagnosticJournalRecoveryStatusSchema,
} from './diagnostic-journal-read-contract';
import { readDiagnosticJournal } from './diagnostic-journal-reader';

/** Disk evidence is the persistent source; only counters and two locations are retained. */
export async function inspectDiagnosticJournalRecovery(
  paths: readonly string[],
  maxLineBytes: number,
): Promise<DiagnosticJournalRecoveryStatus> {
  let anomalies = 0;
  let skippedBytes = 0;
  let firstAnomaly: DiagnosticJournalAnomaly | undefined;
  let lastAnomaly: DiagnosticJournalAnomaly | undefined;
  for await (const result of readDiagnosticJournal({
    paths,
    maxLineBytes,
    eventSchema: z.json(),
  })) {
    if (result.type !== 'anomaly') continue;
    anomalies += 1;
    skippedBytes += result.anomaly.skippedBytes;
    firstAnomaly ??= result.anomaly;
    lastAnomaly = result.anomaly;
  }
  return DiagnosticJournalRecoveryStatusSchema.parse({
    filesChecked: paths.length,
    anomalies,
    skippedBytes,
    ...(firstAnomaly && { firstAnomaly }),
    ...(lastAnomaly && { lastAnomaly }),
  });
}
