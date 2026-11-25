import { z } from 'zod';
import { type PlanWindow, PlanWindowSchema } from '../hello';
import { epochSecondsToIso, nonEmptyString } from '../session-primitives';

const ClaudeWindowSchema = z.looseObject({
  utilization: z.number().min(0),
  resetsAt: z.number().positive().optional(),
});
const ClaudeRateLimitInfoSchema = z.looseObject({
  rateLimitType: z.string().optional(),
  utilization: z.number().min(0).optional(),
  resetsAt: z.number().positive().optional(),
  unifiedWindows: z.record(z.string(), ClaudeWindowSchema).optional(),
});

/**
 * Claude's `rate_limit_event` as windows: `unifiedWindows` when present
 * (`five_hour`, `seven_day`), else the one window it names. Utilization is a
 * fraction; reset times are epoch seconds.
 */
export function claudePlanWindows(info: unknown): PlanWindow[] {
  const parsed = ClaudeRateLimitInfoSchema.safeParse(info);
  if (!parsed.success) return [];
  const toWindow = (name: string, value: { utilization: number; resetsAt?: number }) => {
    const resetsAt = epochSecondsToIso(value.resetsAt);
    return PlanWindowSchema.parse({
      name,
      usedPercent: Math.min(100, value.utilization * 100),
      ...(resetsAt !== undefined && { resetsAt }),
    });
  };
  const { unifiedWindows, rateLimitType, utilization, resetsAt } = parsed.data;
  if (unifiedWindows !== undefined) {
    return Object.entries(unifiedWindows).flatMap(([name, value]) =>
      nonEmptyString(name) !== undefined ? [toWindow(name, value)] : [],
    );
  }
  const singleName = nonEmptyString(rateLimitType);
  if (singleName !== undefined && utilization !== undefined) {
    return [
      toWindow(singleName, { utilization, ...(resetsAt !== undefined && { resetsAt }) }),
    ];
  }
  return [];
}
