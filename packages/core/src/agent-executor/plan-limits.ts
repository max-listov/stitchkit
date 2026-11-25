import { type PlanLimits, PlanLimitsSchema, type PlanWindow, PlanWindowSchema } from './hello';

/** A window whose reset time has passed no longer limits anything. */
export function planWindowExpired(window: PlanWindow, now: Date): boolean {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now.getTime();
}

/** Whether the limits should be read again: never read, a window has reset, or the answer is older than `maxAgeMs`. */
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
  now: Date;
}): PlanLimits {
  const merged = new Map(
    (input.previous?.windows ?? []).map((window) => [window.name, window]),
  );
  for (const window of input.windows) merged.set(window.name, PlanWindowSchema.parse(window));
  const all = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  return PlanLimitsSchema.parse({
    answer: all.length > 0 ? 'known' : (input.previous?.answer ?? 'unpublished'),
    windows: all,
    observedAt: input.now.toISOString(),
  });
}
