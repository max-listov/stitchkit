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

type ResolvedWindow = NonNullable<ReturnType<typeof resolveWindowFields>>;

type BucketWindow = ResolvedWindow & {
  readonly bucket: string;
  readonly slot: 'primary' | 'secondary';
};

function findMatchingWindowIndex(
  windows: readonly BucketWindow[],
  bucket: string,
  slot: 'primary' | 'secondary',
  mins: number | undefined,
  other: ResolvedWindow | undefined,
  excludeIndex: number,
): number {
  const exact = windows.findIndex(
    (w, i) => i !== excludeIndex && w.bucket === bucket && w.slot === slot && w.mins === mins,
  );
  if (exact >= 0) return exact;
  let partialIndex = -1;
  let partialCount = 0;
  for (let i = 0; i < windows.length; i += 1) {
    if (i === excludeIndex) continue;
    const candidate = windows[i];
    if (
      candidate !== undefined &&
      candidate.bucket === bucket &&
      candidate.slot === slot &&
      (candidate.mins === undefined || mins === undefined)
    ) {
      partialIndex = i;
      partialCount += 1;
    }
  }
  if (partialCount === 1) return partialIndex;
  // A duration can move between slots, but never steal a window reserved for the sibling slot
  // in the same snapshot, and an unknown duration never crosses slots.
  if (mins !== undefined) {
    const otherSlot = slot === 'primary' ? 'secondary' : 'primary';
    return windows.findIndex(
      (w, i) =>
        i !== excludeIndex &&
        w.bucket === bucket &&
        w.mins === mins &&
        !(
          other !== undefined &&
          w.slot === otherSlot &&
          (other.mins === undefined || other.mins === w.mins)
        ),
    );
  }
  return -1;
}

function mergeBucket(windows: BucketWindow[], bucket: string, snapshot: ParsedSnapshot): void {
  const primary = resolveWindowFields(snapshot.primary);
  const secondary = resolveWindowFields(snapshot.secondary);
  const slots = { primary, secondary };
  let claimedIndex = -1;
  for (const slot of ['primary', 'secondary'] as const) {
    const measurement = slots[slot];
    if (!measurement) continue;
    const other = slots[slot === 'primary' ? 'secondary' : 'primary'];
    const previous = findMatchingWindowIndex(
      windows,
      bucket,
      slot,
      measurement.mins,
      other,
      claimedIndex,
    );
    const existing = previous >= 0 ? windows[previous] : undefined;
    const window: BucketWindow = {
      usedPercent: measurement.usedPercent,
      mins: measurement.mins ?? existing?.mins,
      resetsAt: measurement.resetsAt ?? existing?.resetsAt,
      bucket,
      slot,
    };
    if (previous >= 0) {
      windows[previous] = window;
      claimedIndex = previous;
    } else if (windows.length < MAX_PLAN_WINDOWS) {
      claimedIndex = windows.length;
      windows.push(window);
    }
  }
}

function nameBucketWindows(
  windows: BucketWindow[],
  bucketLabels: ReadonlyMap<string, string>,
): PlanWindow[] {
  const seen = new Set<string>();
  return windows.map((window) => {
    const { bucket, slot, usedPercent, mins, resetsAt } = window;
    const label = bucketLabels.get(bucket);
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
  const bucketLabels = new Map<string, string>();
  let plan: string | undefined;
  function readBucket(raw: unknown, fallbackId: string): string {
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) return fallbackId;
    const snapshot = parsed.data;
    plan ??= clampPlanName(snapshot.planType ?? snapshot.plan_type, MAX_WINDOW_NAME_CHARS);
    const id = nonEmptyString(snapshot.limitId ?? snapshot.limit_id)?.trim() ?? fallbackId;
    const label = clampPlanName(
      snapshot.limitName ?? snapshot.limit_name,
      MAX_WINDOW_NAME_CHARS,
    );
    if (label !== undefined) bucketLabels.set(id, label);
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
  return { windows: nameBucketWindows(windows, bucketLabels), plan };
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
