import { z } from 'zod';
import type { DiagnosticJournalStartupScan } from './diagnostic-journal-contract';
import {
  type DiagnosticJournalAnomaly,
  type DiagnosticJournalRecoveryStatus,
  DiagnosticJournalRecoveryStatusSchema,
} from './diagnostic-journal-read-contract';
import { readDiagnosticJournal } from './diagnostic-journal-reader';
import { readDiagnosticJournalTails } from './diagnostic-journal-tail';

interface RecoveryInspection {
  readonly paths: readonly string[];
  readonly maxLineBytes: number;
  readonly scan: DiagnosticJournalStartupScan;
  /**
   * A file that could not be read to its end. Its findings are dropped and it is not counted
   * as checked; the handler throws to refuse, or returns once the file is out of the way.
   */
  readonly onUnreadable?: (file: string, error: unknown) => Promise<void>;
}

function readFile(file: string, maxLineBytes: number, scan: DiagnosticJournalStartupScan) {
  return scan === 'full'
    ? readDiagnosticJournal({ paths: [file], maxLineBytes, eventSchema: z.json() })
    : readDiagnosticJournalTails([file], maxLineBytes);
}

/**
 * Disk evidence is the persistent source; only counters and two locations are retained.
 * `tails` checks the final line of every file, which is where a crash tears a
 * journal; `full` reads and validates every line of every file.
 */
export async function inspectDiagnosticJournalRecovery(
  inspection: RecoveryInspection,
): Promise<DiagnosticJournalRecoveryStatus> {
  let filesChecked = 0;
  let anomalies = 0;
  let skippedBytes = 0;
  let firstAnomaly: DiagnosticJournalAnomaly | undefined;
  let lastAnomaly: DiagnosticJournalAnomaly | undefined;
  for (const file of inspection.paths) {
    // Per-file counters are committed only once the file was read to its end.
    let fileAnomalies = 0;
    let fileSkipped = 0;
    let fileFirst: DiagnosticJournalAnomaly | undefined;
    let fileLast: DiagnosticJournalAnomaly | undefined;
    try {
      for await (const result of readFile(file, inspection.maxLineBytes, inspection.scan)) {
        if (result.type !== 'anomaly') continue;
        fileAnomalies += 1;
        fileSkipped += result.anomaly.skippedBytes;
        fileFirst ??= result.anomaly;
        fileLast = result.anomaly;
      }
    } catch (error) {
      if (!inspection.onUnreadable) throw error;
      await inspection.onUnreadable(file, error);
      continue;
    }
    filesChecked += 1;
    anomalies += fileAnomalies;
    skippedBytes += fileSkipped;
    firstAnomaly ??= fileFirst;
    lastAnomaly = fileLast ?? lastAnomaly;
  }
  return DiagnosticJournalRecoveryStatusSchema.parse({
    filesChecked,
    anomalies,
    skippedBytes,
    ...(firstAnomaly && { firstAnomaly }),
    ...(lastAnomaly && { lastAnomaly }),
  });
}
