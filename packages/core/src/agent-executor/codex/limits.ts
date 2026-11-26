import { z } from 'zod';
import { isPositiveSafeInteger } from '../../internal/positive-integer';
import { type PlanWindow, PlanWindowSchema } from '../hello';
import {
  clampUniqueWindowName,
  epochSecondsToIso,
  nonEmptyString,
} from '../session-primitives';

const MAX_WINDOW_NAME_CHARS = 256;
const MAX_PLAN_WINDOWS = 32;

const WindowSchema = z.looseObject({
  usedPercent: z.number().min(0),
  windowDurationMins: z.number().positive().nullable().optional(),
  resetsAt: z.number().nonnegative().nullable().optional(),
});
const SnapshotSchema = z.looseObject({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: WindowSchema.nullable().optional(),
  secondary: WindowSchema.nullable().optional(),
});

type ParsedWindow = z.infer<typeof WindowSchema>;
type ParsedSnapshot = z.infer<typeof SnapshotSchema>;

function positiveSafeInt(value: number | null | undefined): number | undefined {
  return isPositiveSafeInteger(value) ? value : undefined;
}

function clampLabel(value: string | null | undefined): string | undefined {
  const trimmed = nonEmptyString(value)?.trim();
  if (trimmed === undefined) return undefined;
  return trimmed.slice(0, MAX_WINDOW_NAME_CHARS);
}

function appendBucketWindows(
  out: PlanWindow[],
  seenNames: Set<string>,
  bucketId: string,
  seedKey: string,
  snapshot: ParsedSnapshot,
): void {
  const label = clampLabel(snapshot.limitName);
  const primary = snapshot.primary ?? undefined;
  const secondary = snapshot.secondary ?? undefined;
  const primaryMins = positiveSafeInt(primary?.windowDurationMins);
  const secondaryMins = positiveSafeInt(secondary?.windowDurationMins);
  const duplicateDuration =
    primary !== undefined &&
    secondary !== undefined &&
    primaryMins !== undefined &&
    primaryMins === secondaryMins;

  const slots: ReadonlyArray<
    readonly ['primary' | 'secondary', ParsedWindow | undefined, number | undefined]
  > = [
    ['primary', primary, primaryMins],
    ['secondary', secondary, secondaryMins],
  ];
  for (const [slot, window, mins] of slots) {
    if (window === undefined || out.length >= MAX_PLAN_WINDOWS) continue;
    const suffix =
      mins === undefined ? `:${slot}` : duplicateDuration ? `:${mins}m:${slot}` : `:${mins}m`;
    const name = clampUniqueWindowName(
      bucketId,
      suffix,
      seenNames,
      `${seedKey}:${bucketId}:${slot}`,
      MAX_WINDOW_NAME_CHARS,
    );
    const resetsAt =
      window.resetsAt !== undefined && window.resetsAt !== null && window.resetsAt > 0
        ? epochSecondsToIso(window.resetsAt)
        : undefined;
    out.push(
      PlanWindowSchema.parse({
        name,
        usedPercent: Math.min(100, window.usedPercent),
        ...(resetsAt !== undefined && { resetsAt }),
        ...(mins !== undefined && { windowDurationMins: mins }),
        ...(label !== undefined && { label }),
      }),
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize Codex's `account/rateLimits/read` envelope (including multi-bucket
 * `rateLimitsByLimitId`) or a single `RateLimitSnapshot` into {@link PlanWindow} entries.
 *
 * Each window is keyed as `<limitId|limit>:<windowDurationMins>m` (falling back to
 * `<limitId|limit>:<slot>` when duration is absent, or adding `:<slot>` when both slots
 * share the same duration) so weekly and five-hour windows never overwrite each other across
 * buckets. One malformed bucket never discards healthy buckets, clamped names are deduplicated
 * deterministically, and the list is capped at 32 windows to match {@link PlanWindowSchema}.
 */
export function codexPlanWindows(reported: unknown): PlanWindow[] {
  const windows: PlanWindow[] = [];
  const seenNames = new Set<string>();
  if (
    isPlainRecord(reported) &&
    ('rateLimits' in reported || 'rateLimitsByLimitId' in reported)
  ) {
    const seenLimitIds = new Set<string>();
    const rawById = reported.rateLimitsByLimitId;
    if (isPlainRecord(rawById)) {
      for (const mapKey of Object.keys(rawById).sort((a, b) => a.localeCompare(b))) {
        const parsed = SnapshotSchema.safeParse(rawById[mapKey]);
        if (!parsed.success) continue;
        const limitId =
          nonEmptyString(parsed.data.limitId)?.trim() ??
          nonEmptyString(mapKey)?.trim() ??
          'limit';
        seenLimitIds.add(limitId);
        appendBucketWindows(windows, seenNames, limitId, mapKey, parsed.data);
        if (windows.length >= MAX_PLAN_WINDOWS) return windows;
      }
    }
    if (windows.length < MAX_PLAN_WINDOWS && reported.rateLimits !== undefined) {
      const parsedSingle = SnapshotSchema.safeParse(reported.rateLimits);
      if (parsedSingle.success) {
        const explicitId = nonEmptyString(parsedSingle.data.limitId)?.trim();
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
    return windows;
  }

  const single = SnapshotSchema.safeParse(reported);
  if (!single.success) return [];
  const limitId = nonEmptyString(single.data.limitId)?.trim() ?? 'limit';
  appendBucketWindows(windows, seenNames, limitId, limitId, single.data);
  return windows;
}
