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
  durationMs: z.number().nonnegative(),
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
