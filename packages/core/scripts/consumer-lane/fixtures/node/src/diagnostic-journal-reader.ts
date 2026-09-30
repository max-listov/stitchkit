import {
  createDiagnosticJournalReadResultSchema,
  type DiagnosticJournalReadResult,
} from 'stitchkit/application';
import {
  type DiagnosticJournalReaderConfig,
  readDiagnosticJournal,
} from 'stitchkit/application/diagnostic-journal';
import { z } from 'zod';

const eventSchema = z.object({ length: z.string().transform((value) => value.length) });
const config: DiagnosticJournalReaderConfig<typeof eventSchema> = {
  paths: ['/var/lib/example/diagnostic.jsonl'],
  eventSchema,
  maxLineBytes: 4096,
};
const resultSchema = createDiagnosticJournalReadResultSchema(eventSchema);

// Compiled against the packed declarations, not source aliases.
export async function inspectTypedJournal(): Promise<number[]> {
  const lengths: number[] = [];
  for await (const row of readDiagnosticJournal(config)) {
    const result: DiagnosticJournalReadResult<typeof eventSchema> = row;
    if (result.type === 'frame') {
      const length: number = result.frame.event.length;
      lengths.push(length);
    }
  }
  return lengths;
}

export function parseTypedResult(input: unknown): number | undefined {
  const result = resultSchema.parse(input);
  return result.type === 'frame' ? result.frame.event.length : undefined;
}
