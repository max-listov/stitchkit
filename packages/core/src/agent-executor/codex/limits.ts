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

function appendBucketWindows(
  out: PlanWindow[],
  seenNames: Set<string>,
  bucketId: string,
  seedKey: string,
  snapshot: ParsedSnapshot,
): void {
  const label = clampPlanName(
    snapshot.limitName ?? snapshot.limit_name,
    MAX_WINDOW_NAME_CHARS,
  );
  const primary = resolveWindowFields(snapshot.primary);
  const secondary = resolveWindowFields(snapshot.secondary);
  const duplicateDuration =
    primary !== undefined &&
    secondary !== undefined &&
    primary.mins !== undefined &&
    primary.mins === secondary.mins;

  const slots: ReadonlyArray<
    readonly ['primary' | 'secondary', ReturnType<typeof resolveWindowFields>]
  > = [
    ['primary', primary],
    ['secondary', secondary],
  ];
  for (const [slot, window] of slots) {
    if (window === undefined || out.length >= MAX_PLAN_WINDOWS) continue;
    const suffix =
      window.mins === undefined
        ? `:${slot}`
        : duplicateDuration
          ? `:${window.mins}m:${slot}`
          : `:${window.mins}m`;
    const name = clampUniqueWindowName(
      bucketId,
      suffix,
      seenNames,
      `${seedKey}:${bucketId}:${slot}`,
      MAX_WINDOW_NAME_CHARS,
    );
    out.push(
      PlanWindowSchema.parse({
        name,
        usedPercent: Math.min(100, window.usedPercent),
        ...(window.resetsAt !== undefined && { resetsAt: window.resetsAt }),
        ...(window.mins !== undefined && { windowDurationMins: window.mins }),
        ...(label !== undefined && { label }),
      }),
    );
  }
}

function parseCodexRateLimitsInternal(reported: unknown): {
  readonly windows: PlanWindow[];
  readonly plan: string | undefined;
} {
  const windows: PlanWindow[] = [];
  const seenNames = new Set<string>();
  let plan: string | undefined;
  const capturePlan = (snapshot: ParsedSnapshot): void => {
    if (plan === undefined) {
      plan = clampPlanName(snapshot.planType ?? snapshot.plan_type, MAX_WINDOW_NAME_CHARS);
    }
  };

  if (
    isRecord(reported) &&
    ('rateLimits' in reported ||
      'rateLimitsByLimitId' in reported ||
      'rate_limits' in reported ||
      'rate_limits_by_limit_id' in reported)
  ) {
    const seenLimitIds = new Set<string>();
    const rawById = reported.rateLimitsByLimitId ?? reported.rate_limits_by_limit_id;
    if (isRecord(rawById)) {
      for (const mapKey of Object.keys(rawById).sort((a, b) => a.localeCompare(b))) {
        const parsed = SnapshotSchema.safeParse(rawById[mapKey]);
        if (!parsed.success) continue;
        capturePlan(parsed.data);
        const limitId =
          nonEmptyString(parsed.data.limitId ?? parsed.data.limit_id)?.trim() ??
          nonEmptyString(mapKey)?.trim() ??
          'limit';
        seenLimitIds.add(limitId);
        appendBucketWindows(windows, seenNames, limitId, mapKey, parsed.data);
        if (windows.length >= MAX_PLAN_WINDOWS) return { windows, plan };
      }
    }
    const rawSingle = reported.rateLimits ?? reported.rate_limits;
    if (windows.length < MAX_PLAN_WINDOWS && rawSingle !== undefined) {
      const parsedSingle = SnapshotSchema.safeParse(rawSingle);
      if (parsedSingle.success) {
        capturePlan(parsedSingle.data);
        const explicitId = nonEmptyString(
          parsedSingle.data.limitId ?? parsedSingle.data.limit_id,
        )?.trim();
        const shouldIncludeSingle =
          seenLimitIds.size === 0 ||
          (explicitId !== undefined && !seenLimitIds.has(explicitId));
        if (shouldIncludeSingle) {
          appendBucketWindows(
            windows,
            seenNames,
            explicitId ?? 'limit',
            explicitId ?? 'rateLimits',
            parsedSingle.data,
          );
        }
      }
    }
    return { windows, plan };
  }

  const single = SnapshotSchema.safeParse(reported);
  if (!single.success) return { windows: [], plan: undefined };
  capturePlan(single.data);
  const limitId =
    nonEmptyString(single.data.limitId ?? single.data.limit_id)?.trim() ?? 'limit';
  appendBucketWindows(windows, seenNames, limitId, limitId, single.data);
  return { windows, plan };
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
