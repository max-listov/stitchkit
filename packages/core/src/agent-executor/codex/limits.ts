import { z } from 'zod';
import { type PlanWindow, PlanWindowSchema } from '../hello';
import { epochSecondsToIso } from '../session-primitives';

const WindowSchema = z.looseObject({
  usedPercent: z.number().min(0),
  windowDurationMins: z.number().positive().nullable().optional(),
  resetsAt: z.number().positive().nullable().optional(),
});
const RateLimitsSchema = z.looseObject({
  primary: WindowSchema.nullable().optional(),
  secondary: WindowSchema.nullable().optional(),
});

/** Codex's `rateLimits` as plan windows: `primary` and `secondary`, reset times in epoch seconds. */
export function codexPlanWindows(rateLimits: unknown): PlanWindow[] {
  const parsed = RateLimitsSchema.safeParse(rateLimits);
  if (!parsed.success) return [];
  const windows: PlanWindow[] = [];
  for (const name of ['primary', 'secondary'] as const) {
    const window = parsed.data[name];
    if (window === null || window === undefined) continue;
    const resetsAt = epochSecondsToIso(window.resetsAt);
    windows.push(
      PlanWindowSchema.parse({
        name,
        usedPercent: Math.min(100, window.usedPercent),
        ...(resetsAt !== undefined && { resetsAt }),
      }),
    );
  }
  return windows;
}
