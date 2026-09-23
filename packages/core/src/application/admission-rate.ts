/**
 * The sliding windows behind admission's rate budgets: samples expire after
 * their interval, and a refusal says how long until the oldest one does.
 */
import type {
  BoundedAdmissionPerKeyLimits,
  BoundedAdmissionPolicy,
  BoundedRateBudget,
} from './admission';

export interface RateSample {
  readonly at: number;
}

export interface KeyRecord {
  active: number;
  readonly rate: RateSample[];
  /** Resolved once when this record was created; dropped with it on eviction. */
  readonly limits: BoundedAdmissionPerKeyLimits | undefined;
}

function pruneRate(samples: RateSample[], intervalMs: number, at: number): void {
  let expired = 0;
  while (expired < samples.length && at - (samples[expired]?.at ?? at) >= intervalMs) {
    expired += 1;
  }
  if (expired > 0) samples.splice(0, expired);
}

/** Drop expired samples everywhere, and every key that holds nothing any more. */
export function pruneExpired(
  policy: BoundedAdmissionPolicy,
  globalRate: RateSample[],
  keys: Map<string, KeyRecord>,
  at: number,
): void {
  if (policy.global.rate) pruneRate(globalRate, policy.global.rate.intervalMs, at);
  for (const [key, record] of keys) {
    if (record.limits?.rate) pruneRate(record.rate, record.limits.rate.intervalMs, at);
    if (record.active === 0 && record.rate.length === 0) keys.delete(key);
  }
}

/** Milliseconds until the oldest sample leaves its window — at least one. */
export function retryAfter(
  samples: RateSample[],
  budget: BoundedRateBudget,
  at: number,
): number {
  return Math.max(1, Math.ceil(budget.intervalMs - (at - (samples[0]?.at ?? at))));
}

/** Take back one reserved sample, if it is still in its window. */
export function removeSample(samples: RateSample[], sample: RateSample | undefined): void {
  if (!sample) return;
  const index = samples.indexOf(sample);
  if (index >= 0) samples.splice(index, 1);
}
