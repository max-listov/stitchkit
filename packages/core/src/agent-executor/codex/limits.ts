import { z } from 'zod';
import { isPositiveSafeInteger } from '../../internal/positive-integer';
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
  epochMsToIso,
  epochSecondsToIso,
  nonEmptyString,
} from '../session-primitives';

const MAX_WINDOW_NAME_CHARS = 256;
const MAX_PLAN_WINDOWS = 32;
const EPOCH_MS_THRESHOLD = 1e12;

const WindowSchema = z.looseObject({
  usedPercent: z.number().min(0).optional(),
  used_percent: z.number().min(0).optional(),
  windowDurationMins: z.number().positive().nullable().optional(),
  window_duration_mins: z.number().positive().nullable().optional(),
  window_minutes: z.number().positive().nullable().optional(),
  resetsAt: z.union([z.number(), z.string()]).nullable().optional(),
  resets_at: z.union([z.number(), z.string()]).nullable().optional(),
});
const SnapshotSchema = z.looseObject({
  limitId: z.string().nullable().optional(),
  limit_id: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  limit_name: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  plan_type: z.string().nullable().optional(),
  primary: z.unknown().optional(),
  secondary: z.unknown().optional(),
});

type ParsedSnapshot = z.infer<typeof SnapshotSchema>;

function positiveSafeInt(value: number | null | undefined): number | undefined {
  return isPositiveSafeInteger(value) ? value : undefined;
}

function parseCodexResetsAt(raw: number | string | null | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return raw < EPOCH_MS_THRESHOLD ? epochSecondsToIso(raw) : epochMsToIso(raw);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = PlanWindowSchema.shape.resetsAt.safeParse(trimmed);
  return parsed.success ? parsed.data : undefined;
}

function resolveWindowFields(raw: unknown):
  | {
      readonly usedPercent: number;
      readonly mins: number | undefined;
      readonly resetsAt: string | undefined;
    }
  | undefined {
  const parsed = WindowSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const window = parsed.data;
  const usedPercent = window.usedPercent ?? window.used_percent;
  if (usedPercent === undefined || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return undefined;
  }
  const mins = positiveSafeInt(
    window.windowDurationMins ?? window.window_duration_mins ?? window.window_minutes,
  );
  const resetsAt = parseCodexResetsAt(window.resetsAt ?? window.resets_at);
  return { usedPercent, mins, resetsAt };
}

type BucketWindow = NonNullable<ReturnType<typeof resolveWindowFields>> & {
  readonly bucket: string;
  readonly slot: 'primary' | 'secondary';
  readonly label: string | undefined;
};

function mergeBucket(windows: BucketWindow[], bucket: string, snapshot: ParsedSnapshot): void {
  const label = clampPlanName(
    snapshot.limitName ?? snapshot.limit_name,
    MAX_WINDOW_NAME_CHARS,
  );
  const primary = resolveWindowFields(snapshot.primary);
  const secondary = resolveWindowFields(snapshot.secondary);
  const sharedDuration = primary?.mins !== undefined && primary.mins === secondary?.mins;
  const slots = { primary, secondary };
  for (const slot of ['primary', 'secondary'] as const) {
    const measurement = slots[slot];
    if (!measurement) continue;
    const sameDuration = (w: BucketWindow) =>
      w.bucket === bucket && w.mins === measurement.mins;
    let previous = windows.findIndex((w) => sameDuration(w) && w.slot === slot);
    // A duration can move between slots. Only two equally long windows in the same snapshot
    // need the slot to distinguish them; an unknown duration always keeps its slot.
    if (previous < 0 && measurement.mins !== undefined && !sharedDuration) {
      previous = windows.findIndex(sameDuration);
    }
    const window = { ...measurement, bucket, slot, label };
    if (previous >= 0) windows[previous] = window;
    else if (windows.length < MAX_PLAN_WINDOWS) windows.push(window);
  }
}

function nameBucketWindows(windows: BucketWindow[]): PlanWindow[] {
  const seen = new Set<string>();
  return windows.map((window) => {
    const { bucket, slot, usedPercent, mins, resetsAt, label } = window;
    const sharedDuration =
      mins !== undefined &&
      windows.some(
        (other) => other !== window && other.bucket === bucket && other.mins === mins,
      );
    const suffix =
      mins === undefined ? `:${slot}` : sharedDuration ? `:${mins}m:${slot}` : `:${mins}m`;
    const name = clampUniqueWindowName(
      bucket,
      suffix,
      seen,
      `${bucket}:${slot}`,
      MAX_WINDOW_NAME_CHARS,
    );
    return PlanWindowSchema.parse({
      name,
      usedPercent: Math.min(100, usedPercent),
      ...(resetsAt !== undefined && { resetsAt }),
      ...(mins !== undefined && { windowDurationMins: mins }),
      ...(label !== undefined && { label }),
    });
  });
}

function parseCodexRateLimitsInternal(reported: unknown): {
  readonly windows: PlanWindow[];
  readonly plan: string | undefined;
} {
  if (!isRecord(reported)) return { windows: [], plan: undefined };
  const windows: BucketWindow[] = [];
  let plan: string | undefined;
  function readBucket(raw: unknown, fallbackId: string): string {
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) return fallbackId;
    const snapshot = parsed.data;
    plan ??= clampPlanName(snapshot.planType ?? snapshot.plan_type, MAX_WINDOW_NAME_CHARS);
    const id = nonEmptyString(snapshot.limitId ?? snapshot.limit_id)?.trim() ?? fallbackId;
    mergeBucket(windows, id, snapshot);
    return id;
  }

  const byId = reported.rateLimitsByLimitId ?? reported.rate_limits_by_limit_id;
  // The legacy account view can omit its ID even when the keyed account is also present.
  const defaultId = isRecord(byId) && isRecord(byId.codex) ? 'codex' : 'limit';
  const accountId = readBucket(
    reported.rateLimits ?? reported.rate_limits ?? reported,
    defaultId,
  );
  if (isRecord(byId)) {
    if (Object.hasOwn(byId, accountId)) readBucket(byId[accountId], accountId);
    for (const key of Object.keys(byId).sort((a, b) => a.localeCompare(b))) {
      if (windows.length >= MAX_PLAN_WINDOWS) break;
      if (key !== accountId) readBucket(byId[key], nonEmptyString(key)?.trim() ?? 'limit');
    }
  }
  return { windows: nameBucketWindows(windows), plan };
}

/**
 * Normalize Codex's `account/rateLimits/read` envelope (camelCase or snake_case rollout
 * `token_count` payloads, including multi-bucket `rateLimitsByLimitId`) or a single
 * `RateLimitSnapshot` into {@link PlanWindow} entries.
 *
 * Each window is keyed as `<limitId|limit>:<windowDurationMins>m` (falling back to
 * `<limitId|limit>:<slot>` when duration is absent, or adding `:<slot>` when both slots
 * share the same duration) so weekly and five-hour windows never overwrite each other across
 * buckets. One malformed bucket never discards healthy buckets, clamped names are deduplicated
 * deterministically, and the list is capped at 32 windows to match {@link PlanWindowSchema}.
 */
export function codexPlanWindows(reported: unknown): PlanWindow[] {
  return parseCodexRateLimitsInternal(reported).windows;
}

/**
 * Normalize a Codex `account/rateLimits/read` response or rollout `token_count` payload into a
 * complete {@link PlanLimits} snapshot, preserving `plan` (`planType` / `plan_type`) when present.
 */
export function codexPlanLimits(reported: unknown, now: Date = new Date()): PlanLimits {
  const { windows, plan } = parseCodexRateLimitsInternal(reported);
  return PlanLimitsSchema.parse({
    answer: windows.length > 0 ? 'known' : 'unpublished',
    windows,
    observedAt: now.toISOString(),
    ...(plan !== undefined && { plan }),
  });
}
