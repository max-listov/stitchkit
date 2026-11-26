import { z } from 'zod';
import {
  type PlanLimits,
  PlanLimitsSchema,
  type PlanWindow,
  PlanWindowSchema,
} from '../hello';
import {
  clampUniqueWindowName,
  epochSecondsToIso,
  nonEmptyString,
} from '../session-primitives';

const MAX_WINDOW_NAME_CHARS = 256;
const MAX_PLAN_WINDOWS = 32;

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

const ClaudeUsageWindowSchema = z.looseObject({
  utilization: z.number().min(0).nullish(),
  resets_at: z.string().nullish(),
});
const ClaudeModelScopedWindowSchema = z.looseObject({
  display_name: z.string().nullish(),
  utilization: z.number().min(0).nullish(),
  resets_at: z.string().nullish(),
});
const ClaudeUsageResponseSchema = z.looseObject({
  subscription_type: z.string().nullish(),
  rate_limits_available: z.boolean().optional(),
  rate_limits: z.record(z.string(), z.unknown()).nullish(),
});

const FIXED_USAGE_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
] as const;

function parseIsoReset(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = PlanWindowSchema.shape.resetsAt.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Normalize an active Claude SDK `get_usage` response (`SDKControlGetUsageResponse`) into
 * {@link PlanLimits}. Unlike passive `rate_limit_event` (0–1 fraction + epoch seconds),
 * `get_usage` reports utilization in percent (0–100, nullable) and ISO-8601 `resets_at`.
 */
export function claudeUsagePlanLimits(raw: unknown, now: Date): PlanLimits {
  const parsed = ClaudeUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return PlanLimitsSchema.parse({
      answer: 'unpublished',
      windows: [],
      observedAt: now.toISOString(),
    });
  }
  const { subscription_type, rate_limits_available, rate_limits } = parsed.data;
  if (rate_limits_available === false) {
    return PlanLimitsSchema.parse({
      answer:
        nonEmptyString(subscription_type) !== undefined ? 'unpublished' : 'no-plan-limit',
      windows: [],
      observedAt: now.toISOString(),
    });
  }
  const windows: PlanWindow[] = [];
  const seenNames = new Set<string>();
  if (rate_limits != null) {
    for (const key of FIXED_USAGE_WINDOWS) {
      if (windows.length >= MAX_PLAN_WINDOWS) break;
      const entryParsed = ClaudeUsageWindowSchema.safeParse(rate_limits[key]);
      if (!entryParsed.success) continue;
      const entry = entryParsed.data;
      if (entry.utilization == null || !Number.isFinite(entry.utilization)) continue;
      const resetsAt = parseIsoReset(entry.resets_at);
      seenNames.add(key);
      windows.push(
        PlanWindowSchema.parse({
          name: key,
          usedPercent: Math.min(100, entry.utilization),
          ...(resetsAt !== undefined && { resetsAt }),
        }),
      );
    }
    const modelScoped = rate_limits.model_scoped;
    if (Array.isArray(modelScoped)) {
      for (let index = 0; index < modelScoped.length; index += 1) {
        if (windows.length >= MAX_PLAN_WINDOWS) break;
        const entry = ClaudeModelScopedWindowSchema.safeParse(modelScoped[index]);
        if (!entry.success) continue;
        const { display_name, utilization, resets_at } = entry.data;
        const label = nonEmptyString(display_name)?.trim().slice(0, MAX_WINDOW_NAME_CHARS);
        if (label === undefined || utilization == null || !Number.isFinite(utilization))
          continue;
        const name = clampUniqueWindowName(
          `model:${label}`,
          '',
          seenNames,
          `model:${display_name ?? label}:${index}`,
          MAX_WINDOW_NAME_CHARS,
        );
        const resetsAt = parseIsoReset(resets_at);
        windows.push(
          PlanWindowSchema.parse({
            name,
            usedPercent: Math.min(100, utilization),
            ...(resetsAt !== undefined && { resetsAt }),
            label,
          }),
        );
      }
    }
  }
  return PlanLimitsSchema.parse({
    answer: rate_limits_available === true && windows.length > 0 ? 'known' : 'unpublished',
    windows,
    observedAt: now.toISOString(),
  });
}

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
