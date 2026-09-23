import { z } from 'zod';

const PositiveSafeIntegerSchema = z.number().int().positive().safe();

export const BackoffPolicySchema = z
  .object({
    minDelayMs: PositiveSafeIntegerSchema,
    maxDelayMs: PositiveSafeIntegerSchema,
    /** Fraction of the computed delay that is randomised away, `0`–`1`. */
    jitter: z.number().min(0).max(1),
  })
  .strict()
  .readonly()
  .refine((policy) => policy.maxDelayMs >= policy.minDelayMs, {
    message: 'maxDelayMs must be at least minDelayMs',
  });
export type BackoffPolicy = z.infer<typeof BackoffPolicySchema>;

/**
 * The delay before retry number `attempt` (1-based) under `policy`: doubling
 * from `minDelayMs`, capped at `maxDelayMs`, with `jitter` subtracted. The one
 * formula behind `createBackoff` and every attempt-numbered retry schedule.
 */
export function backoffDelay(
  policy: BackoffPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.minDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const spread = exponential * policy.jitter * random();
  return Math.max(1, Math.round(exponential - spread));
}

export interface Backoff {
  /** The next delay in milliseconds, doubling from `minDelayMs` and jittered. */
  next(): number;
  reset(): void;
}

/**
 * Exponential backoff with jitter, as a value.
 *
 * Jitter is the part that is easy to leave out and expensive to leave out: without it every
 * consumer that lost the same server retries at the same instant, and the recovering server is
 * hit by the whole fleet at once instead of a spread. The randomisation is subtractive — a delay
 * is never longer than the ceiling the caller declared, only shorter — so `maxDelayMs` remains a
 * real bound rather than an average.
 */
export function createBackoff(
  policy: BackoffPolicy,
  random: () => number = Math.random,
): Backoff {
  const parsed = BackoffPolicySchema.parse(policy);
  let attempt = 0;
  return {
    next() {
      attempt += 1;
      return backoffDelay(parsed, attempt, random);
    },
    reset() {
      attempt = 0;
    },
  };
}
