import { z } from 'zod';

const NonNegativeIntegerSchema = z.number().int().nonnegative();

/** Immutable operational snapshot for one bounded observability sink. */
export const ObservabilitySinkStatusSchema = z
  .object({
    capacity: NonNegativeIntegerSchema,
    received: NonNegativeIntegerSchema,
    accepted: NonNegativeIntegerSchema,
    filtered: NonNegativeIntegerSchema,
    completed: NonNegativeIntegerSchema,
    dropped: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
    preparationFailed: NonNegativeIntegerSchema,
    preparing: NonNegativeIntegerSchema,
    pending: NonNegativeIntegerSchema,
    closed: z.boolean(),
  })
  .readonly();

export type ObservabilitySinkStatus = z.infer<typeof ObservabilitySinkStatusSchema>;

/** Immutable snapshot for every enabled observability surface and their aggregate. */
const ObservabilityStatusObjectSchema = z.object({
  request: ObservabilitySinkStatusSchema.optional(),
  tools: ObservabilitySinkStatusSchema.optional(),
  total: ObservabilitySinkStatusSchema,
});

export const ObservabilityStatusSchema = ObservabilityStatusObjectSchema.readonly();

export type ObservabilityStatus = z.infer<typeof ObservabilityStatusSchema>;

/** Final immutable state returned after observability admission closes and drains. */
export const ObservabilityDrainReportSchema = ObservabilityStatusObjectSchema.extend({
  /**
   * How long the DRAIN has run, not how long this call waited.
   *
   * The drain is started once and shared, so a second `close` under its own
   * bound reports the age of the one drain — a caller that waited 20 ms after
   * an earlier close began 300 ms ago reads 320, not 20. For the ordinary
   * single close the two are the same number; for a shutdown log that wants
   * its own wait, measure it at the call site.
   */
  durationMs: z.number().nonnegative(),
  /**
   * Whether every accepted event settled before the caller's bound expired.
   *
   * `false` means the drain gave up waiting and `total.pending` plus
   * `total.preparing` are events the sink had not written — the number a
   * shutdown log can state instead of guessing. Always `true` for an unbounded
   * close, which waits however long the sink takes.
   */
  drained: z.boolean(),
}).readonly();

export type ObservabilityDrainReport = z.infer<typeof ObservabilityDrainReportSchema>;

type SinkStatusKey = Exclude<keyof ObservabilitySinkStatus, 'closed'>;

const SUMMED_STATUS_KEYS: readonly SinkStatusKey[] = [
  'capacity',
  'received',
  'accepted',
  'filtered',
  'completed',
  'dropped',
  'failed',
  'preparationFailed',
  'preparing',
  'pending',
];

/** Build and freeze the aggregate without exposing mutable counters. */
export function aggregateObservabilityStatus(
  surfaces: readonly ObservabilitySinkStatus[],
  closed: boolean,
): ObservabilitySinkStatus {
  const totals: Record<SinkStatusKey, number> = {
    capacity: 0,
    received: 0,
    accepted: 0,
    filtered: 0,
    completed: 0,
    dropped: 0,
    failed: 0,
    preparationFailed: 0,
    preparing: 0,
    pending: 0,
  };
  for (const surface of surfaces) {
    for (const key of SUMMED_STATUS_KEYS) totals[key] += surface[key];
  }
  return ObservabilitySinkStatusSchema.parse({ ...totals, closed });
}
