/**
 * Opens a diagnostic journal at `argv[2]` with the startup-refusal policy `argv[3]` and prints
 * one JSON line: the recovery status it started with, or the typed refusal it threw. Bundled for
 * Node and run as an unprivileged user, so a file mode of 0 is a real `EACCES`.
 */
import { z } from 'zod';
import { createDiagnosticJournal } from '../../src/application/diagnostic-journal';
import { DiagnosticJournalStartupRefusalPolicySchema } from '../../src/application/diagnostic-journal-contract';
import { DiagnosticJournalRecoveryError } from '../../src/application/diagnostic-journal-read-contract';

const path = z.string().parse(process.argv[2]);
const onStartupRefusal = DiagnosticJournalStartupRefusalPolicySchema.parse(process.argv[3]);

try {
  const journal = await createDiagnosticJournal({
    path,
    eventSchema: z.object({ message: z.string() }).strict(),
    limits: {
      maxEventBytes: 1024,
      maxPendingItems: 4,
      maxPendingBytes: 8192,
      maxFileBytes: 4096,
      maxFiles: 4,
    },
    onStartupRefusal,
  });
  const recovery = journal.getStatus().recovery;
  await journal.close();
  console.log(JSON.stringify({ outcome: 'started', recovery }));
} catch (error) {
  if (!(error instanceof DiagnosticJournalRecoveryError)) throw error;
  console.log(JSON.stringify({ outcome: 'refused', reason: error.reason, file: error.file }));
}
