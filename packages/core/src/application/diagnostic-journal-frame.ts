import { z } from 'zod';

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
