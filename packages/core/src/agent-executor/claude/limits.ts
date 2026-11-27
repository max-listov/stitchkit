import { z } from 'zod';
import { isRecord } from '../../internal/typed';
import {
  type PlanLimits,
  PlanLimitsSchema,
  type PlanWindow,
  PlanWindowSchema,
} from '../hello';
import {
  clampPlanName,
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

const FIXED_USAGE_WINDOW_SET = new Set<string>(FIXED_USAGE_WINDOWS);
const SKIPPED_USAGE_KEYS = new Set<string>([
  'extra_usage',
  'limits',
  'spend',
  'model_scoped',
  'subscription_type',
  'rate_limits_available',
  'rate_limits',
]);

function parseIsoReset(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = PlanWindowSchema.shape.resetsAt.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function appendUsageBucket(
  windows: PlanWindow[],
  seenNames: Set<string>,
  key: string,
  rawEntry: unknown,
): void {
  if (windows.length >= MAX_PLAN_WINDOWS || !isRecord(rawEntry)) return;
  const entryParsed = ClaudeUsageWindowSchema.safeParse(rawEntry);
  if (!entryParsed.success) return;
  const entry = entryParsed.data;
  if (entry.utilization == null || !Number.isFinite(entry.utilization)) return;
  const trimmedKey = nonEmptyString(key)?.trim();
  if (trimmedKey === undefined) return;
  const resetsAt = parseIsoReset(entry.resets_at);
  const name = clampUniqueWindowName(trimmedKey, '', seenNames, key, MAX_WINDOW_NAME_CHARS);
  windows.push(
    PlanWindowSchema.parse({
      name,
      usedPercent: Math.min(100, entry.utilization),
      ...(resetsAt !== undefined && { resetsAt }),
    }),
  );
}

function extractUsageWindows(bucketMap: Record<string, unknown>): PlanWindow[] {
  const windows: PlanWindow[] = [];
  const seenNames = new Set<string>();
  for (const key of FIXED_USAGE_WINDOWS) {
    if (windows.length >= MAX_PLAN_WINDOWS) break;
    if (key in bucketMap) appendUsageBucket(windows, seenNames, key, bucketMap[key]);
  }
  for (const key of Object.keys(bucketMap).sort((a, b) => a.localeCompare(b))) {
    if (windows.length >= MAX_PLAN_WINDOWS) break;
    if (FIXED_USAGE_WINDOW_SET.has(key) || SKIPPED_USAGE_KEYS.has(key)) continue;
    appendUsageBucket(windows, seenNames, key, bucketMap[key]);
  }
  const modelScoped = bucketMap.model_scoped;
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
  return windows;
}

/**
 * Normalize an active Claude SDK `get_usage` response (`SDKControlGetUsageResponse`) or flat
 * `/api/oauth/usage` payload into {@link PlanLimits}, preserving `plan` (`subscription_type`) and
 * reading any window-shaped quota buckets while skipping non-window fields (`extra_usage`,
 * `limits`, `spend`). Unlike passive `rate_limit_event` (0–1 fraction + epoch seconds), usage
 * payloads report utilization in percent (0–100, nullable) and ISO-8601 `resets_at`.
 */
export function claudeUsagePlanLimits(raw: unknown, now: Date = new Date()): PlanLimits {
  const parsed = ClaudeUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return PlanLimitsSchema.parse({
      answer: 'unpublished',
      windows: [],
      observedAt: now.toISOString(),
    });
  }
  const { subscription_type, rate_limits_available, rate_limits } = parsed.data;
  const plan = clampPlanName(subscription_type, MAX_WINDOW_NAME_CHARS);
  const isEnvelope = isRecord(raw) && ('rate_limits' in raw || 'rate_limits_available' in raw);
  if (rate_limits_available === false) {
    return PlanLimitsSchema.parse({
      answer: plan !== undefined ? 'unpublished' : 'no-plan-limit',
      windows: [],
      observedAt: now.toISOString(),
      ...(plan !== undefined && { plan }),
    });
  }
  const bucketMap = isEnvelope
    ? isRecord(rate_limits)
      ? rate_limits
      : undefined
    : isRecord(raw)
      ? raw
      : undefined;
  const windows = bucketMap !== undefined ? extractUsageWindows(bucketMap) : [];
  const answer = windows.length > 0 ? 'known' : 'unpublished';
  return PlanLimitsSchema.parse({
    answer,
    windows,
    observedAt: now.toISOString(),
    ...(plan !== undefined && { plan }),
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
