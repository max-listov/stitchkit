import { z } from 'zod';
import { DiagnosticJournalFrameSchema } from './diagnostic-journal-frame';

const ByteCountSchema = z.number().int().nonnegative();
const LocationSchema = z.object({
  file: z.string(),
  offset: ByteCountSchema,
  line: z.number().int().positive(),
});

export const DiagnosticJournalAnomalySchema = LocationSchema.extend({
  reason: z.enum([
    'nul-byte',
    'unterminated-line',
    'invalid-utf8',
    'invalid-json',
    'invalid-frame',
    'invalid-event',
    'oversized-line',
  ]),
  position: z.enum(['tail', 'interior']),
  terminated: z.boolean(),
  /** Bytes omitted from the frame stream, including LF when present. */
  skippedBytes: ByteCountSchema,
})
  .strict()
  .readonly();
export type DiagnosticJournalAnomaly = z.infer<typeof DiagnosticJournalAnomalySchema>;

export function createDiagnosticJournalReadResultSchema<SCHEMA extends z.ZodType>(
  eventSchema: SCHEMA,
) {
  return z.discriminatedUnion('type', [
    LocationSchema.extend({
      type: z.literal('frame'),
      bytes: ByteCountSchema,
      frame: DiagnosticJournalFrameSchema.unwrap().extend({ event: eventSchema }).readonly(),
    })
      .strict()
      .readonly(),
    z
      .object({ type: z.literal('anomaly'), anomaly: DiagnosticJournalAnomalySchema })
      .strict()
      .readonly(),
  ]);
}
export type DiagnosticJournalReadResult<SCHEMA extends z.ZodType> = z.output<
  ReturnType<typeof createDiagnosticJournalReadResultSchema<SCHEMA>>
>;

export const DiagnosticJournalRecoveryStatusSchema = z
  .object({
    filesChecked: ByteCountSchema,
    anomalies: ByteCountSchema,
    skippedBytes: ByteCountSchema,
    firstAnomaly: DiagnosticJournalAnomalySchema.optional(),
    lastAnomaly: DiagnosticJournalAnomalySchema.optional(),
  })
  .strict()
  .readonly();
export type DiagnosticJournalRecoveryStatus = z.infer<
  typeof DiagnosticJournalRecoveryStatusSchema
>;

/** A single-file retention policy cannot preserve the torn file during startup rotation. */
export class DiagnosticJournalRecoveryError extends Error {
  constructor(public readonly recovery: DiagnosticJournalRecoveryStatus) {
    super('Diagnostic journal tail recovery requires maxFiles >= 2; no data was removed');
    this.name = 'DiagnosticJournalRecoveryError';
  }
}
