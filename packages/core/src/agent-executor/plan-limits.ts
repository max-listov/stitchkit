import { isPositiveSafeInteger } from '../internal/positive-integer';
import { type PlanLimits, PlanLimitsSchema, type PlanWindow, PlanWindowSchema } from './hello';
import { clampPlanName } from './session-primitives';

const MINUTES_SUFFIX = /:([1-9]\d*)m(?::|$)/;

/** A window whose reset time has passed no longer limits anything. */
export function planWindowExpired(window: PlanWindow, now: Date): boolean {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now.getTime();
}

/**
 * Return the duration of a {@link PlanWindow} in minutes when known: prefers the explicit
 * `windowDurationMins` field, falling back to canonical window names (`five_hour*` → 300,
 * `seven_day*` / `weekly` → 10080, `:<N>m` → `N`), or `undefined` when unknown.
 */
export function planWindowDurationMins(
  window: PlanWindow | Pick<PlanWindow, 'name' | 'windowDurationMins'>,
): number | undefined {
  if (window.windowDurationMins !== undefined) return window.windowDurationMins;
  if (window.name === 'five_hour' || window.name.startsWith('five_hour_')) return 300;
  if (
    window.name === 'seven_day' ||
    window.name.startsWith('seven_day_') ||
    window.name === 'weekly'
  ) {
    return 10_080;
  }
  const match = MINUTES_SUFFIX.exec(window.name);
  if (match?.[1] !== undefined) {
    const parsed = Number(match[1]);
    if (isPositiveSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Whether the limits should be read again: never read, a window has reset, or a `known` / errored
 * answer is older than `maxAgeMs`. Clean `no-plan-limit` and `unpublished` answers without an
 * `error` do not trigger periodic re-polling.
 */
export function planLimitsDue(input: {
  limits?: PlanLimits | undefined;
  now: Date;
  maxAgeMs: number;
}): boolean {
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) {
    throw new RangeError(
      `planLimitsDue maxAgeMs must be a finite non-negative number, received ${input.maxAgeMs}`,
    );
  }
  if (input.limits === undefined) return true;
  if (input.limits.answer !== 'known' && input.limits.error === undefined) return false;
  if (input.limits.windows.some((window) => planWindowExpired(window, input.now))) return true;
  return input.now.getTime() - Date.parse(input.limits.observedAt) >= input.maxAgeMs;
}

/**
 * A read that failed keeps the last answer that succeeded and says why the
 * newest read did not; with no answer yet, the limits are `unpublished`.
 */
export function planLimitsReadFailed(input: {
  previous?: PlanLimits | undefined;
  error: string;
  now: Date;
}): PlanLimits {
  return PlanLimitsSchema.parse(
    input.previous === undefined
      ? {
          answer: 'unpublished',
          windows: [],
          observedAt: input.now.toISOString(),
          error: input.error,
        }
      : { ...input.previous, error: input.error },
  );
}

/** Windows reported by an engine during a turn, merged over the last answer by name. */
export function mergeRateLimitEvent(input: {
  previous?: PlanLimits | undefined;
  windows: readonly PlanWindow[];
  plan?: string | undefined;
  now: Date;
}): PlanLimits {
  const merged = new Map(
    (input.previous?.windows ?? []).map((window) => [window.name, window]),
  );
  for (const window of input.windows) merged.set(window.name, PlanWindowSchema.parse(window));
  const all = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  const plan = clampPlanName(input.plan) ?? input.previous?.plan;
  return PlanLimitsSchema.parse({
    answer: all.length > 0 ? 'known' : (input.previous?.answer ?? 'unpublished'),
    windows: all,
    observedAt: input.now.toISOString(),
    ...(plan !== undefined && { plan }),
  });
}
