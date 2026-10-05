import { z } from 'zod';
import { DiagnosticJournalFrameSchema } from './diagnostic-journal-frame';

const ByteCountSchema = z.number().int().nonnegative();
const LocationSchema = z.object({
  file: z.string(),
  offset: ByteCountSchema,
  line: z.number().int().positive(),
});

/**
 * A damaged region found while reading a journal: file, offset, line, reason, whether it is at
 * the tail, and how many bytes were skipped.
 */
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
/** A damaged region found while reading a journal; reading goes on after it. */
export type DiagnosticJournalAnomaly = z.infer<typeof DiagnosticJournalAnomalySchema>;

/**
 * Builds the Zod schema of one read result for your event schema: a `frame` carrying a parsed
 * event, or an `anomaly`.
 */
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
/**
 * One item yielded by `readDiagnosticJournal`: a `frame` with its event and location, or an
 * `anomaly` for a damaged region.
 */
export type DiagnosticJournalReadResult<SCHEMA extends z.ZodType> = z.output<
  ReturnType<typeof createDiagnosticJournalReadResultSchema<SCHEMA>>
>;

/**
 * Why opening a journal could not keep a file in place: a torn active file with no retention slot
 * to rotate it into, a retained name that is not a regular file, or a file that could not be read.
 */
export const DiagnosticJournalStartupRefusalReasonSchema = z.enum([
  'torn-without-retention-slot',
  'not-a-regular-file',
  'unreadable',
]);
/** The inferred value of {@link DiagnosticJournalStartupRefusalReasonSchema}. */
export type DiagnosticJournalStartupRefusalReason = z.infer<
  typeof DiagnosticJournalStartupRefusalReasonSchema
>;

/**
 * How many quarantined files one status lists. The rest are counted in `quarantinedUnlisted`, so a
 * directory holding thousands of them cannot grow the status without bound.
 */
export const DIAGNOSTIC_JOURNAL_LISTED_QUARANTINE_LIMIT = 32;

const QuarantinedFileSchema = z
  .object({
    /** Where the file was. */
    file: z.string(),
    /** Where it is now: the same directory, `<file>.quarantined-<epoch>`. */
    quarantinedAs: z.string(),
    /**
     * Why this open moved the file. Absent for a file an earlier open moved: the name carries
     * that open's epoch, and its own status reported the reason.
     */
    reason: DiagnosticJournalStartupRefusalReasonSchema.optional(),
    /** The system error code of an `unreadable` file, such as `EACCES`. */
    code: z.string().optional(),
  })
  .strict()
  .readonly();

/**
 * Counts from checking a journal at startup: files checked, anomalies found, bytes skipped, the
 * first and last anomaly, and the quarantined files beside the journal.
 *
 * Stability: this schema follows the maturity of `stitchkit/application` (evolving). It is
 * `.strict()`, so a reader parsing with an older copy refuses a status that carries a key it does
 * not know: every change to its shape, an added optional field included, is listed under
 * `⚠️ Breaking changes` in the changelog for consumers that embed it in their own protocol.
 */
export const DiagnosticJournalRecoveryStatusSchema = z
  .object({
    filesChecked: ByteCountSchema,
    anomalies: ByteCountSchema,
    skippedBytes: ByteCountSchema,
    firstAnomaly: DiagnosticJournalAnomalySchema.optional(),
    lastAnomaly: DiagnosticJournalAnomalySchema.optional(),
    /**
     * Every `<file>.quarantined-*` beside the journal, listed on each open until an operator
     * removes it; the journal never deletes one. Files this open moved come first, with their
     * `reason`, then earlier ones by name, at most
     * {@link DIAGNOSTIC_JOURNAL_LISTED_QUARANTINE_LIMIT}.
     */
    quarantined: z
      .array(QuarantinedFileSchema)
      .max(DIAGNOSTIC_JOURNAL_LISTED_QUARANTINE_LIMIT)
      .readonly()
      .optional(),
    /** Quarantined files present beyond the listed ones; absent when every one is listed. */
    quarantinedUnlisted: z.number().int().positive().optional(),
  })
  .strict()
  .readonly();
/**
 * Counts from checking a journal at startup: files checked, anomalies found, bytes skipped,
 * the first and last anomaly, and the quarantined files beside the journal.
 */
export type DiagnosticJournalRecoveryStatus = z.infer<
  typeof DiagnosticJournalRecoveryStatusSchema
>;

/** What a startup refusal names: the file, the reason and what was observed or failed. */
export interface DiagnosticJournalRecoveryErrorOptions {
  readonly reason: DiagnosticJournalStartupRefusalReason;
  readonly file: string;
  /** The inspection of a torn file, when the refusal is `torn-without-retention-slot`. */
  readonly recovery?: DiagnosticJournalRecoveryStatus;
  /** The refusal stands because moving the file aside failed; `cause` holds both errors. */
  readonly quarantineFailed?: boolean;
  readonly cause?: unknown;
}

const REFUSAL_MESSAGES: Record<DiagnosticJournalStartupRefusalReason, string> = {
  'torn-without-retention-slot':
    'Diagnostic journal tail recovery requires maxFiles >= 2; no data was removed',
  'not-a-regular-file': 'Diagnostic journal generations must be regular files',
  unreadable: 'Diagnostic journal could not read a retained file',
};

/**
 * Opening a journal refused a file it could not keep in place. Thrown under
 * `onStartupRefusal: 'fail'`, and under `'quarantine'` when moving the file aside failed (then
 * `quarantineFailed` is true). No evidence is removed and the lock is released.
 */
export class DiagnosticJournalRecoveryError extends Error {
  readonly reason: DiagnosticJournalStartupRefusalReason;
  readonly file: string;
  readonly recovery?: DiagnosticJournalRecoveryStatus;
  readonly quarantineFailed: boolean;

  constructor(options: DiagnosticJournalRecoveryErrorOptions) {
    const quarantineFailed = options.quarantineFailed ?? false;
    super(
      `${REFUSAL_MESSAGES[options.reason]}: ${options.file}${quarantineFailed ? ' (moving it aside failed)' : ''}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DiagnosticJournalRecoveryError';
    this.reason = options.reason;
    this.file = options.file;
    if (options.recovery) this.recovery = options.recovery;
    this.quarantineFailed = quarantineFailed;
  }
}
