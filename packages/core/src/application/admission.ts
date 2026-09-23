import { z } from 'zod';
import {
  type KeyRecord,
  pruneExpired,
  type RateSample,
  removeSample,
  retryAfter,
} from './admission-rate';
import { runAdmitted } from './admission-run';
import type { ApplicationAdmission, ApplicationOperationLease } from './kernel-contract';

const PositiveSafeIntegerSchema = z.number().int().positive().safe();

export const BoundedRateBudgetSchema = z
  .object({
    limit: PositiveSafeIntegerSchema,
    intervalMs: PositiveSafeIntegerSchema,
  })
  .strict()
  .readonly();
export type BoundedRateBudget = z.infer<typeof BoundedRateBudgetSchema>;

export const BoundedAdmissionPerKeyLimitsSchema = z
  .object({
    maxConcurrent: PositiveSafeIntegerSchema,
    rate: BoundedRateBudgetSchema.optional(),
  })
  .strict()
  .readonly();
export type BoundedAdmissionPerKeyLimits = z.infer<typeof BoundedAdmissionPerKeyLimitsSchema>;

/**
 * A ceiling declared per key rather than once for all keys.
 *
 * Resolved on a key's first admission and cached with its record, so a resolver that reads
 * configuration is called once per live key rather than once per acquire. Eviction under
 * `maxKeys` drops the record and the cached ceiling together, which is also how a changed
 * configuration is adopted: evict the key, and the next admission resolves it again.
 */
export type BoundedAdmissionPerKeyLimitResolver = (
  key: string,
) => BoundedAdmissionPerKeyLimits;

const PerKeyLimitResolverSchema = z.custom<BoundedAdmissionPerKeyLimitResolver>(
  (value) => typeof value === 'function',
  { message: 'perKey.limits must be a function of the key' },
);

export const BoundedAdmissionPolicySchema = z
  .object({
    global: z
      .object({
        maxConcurrent: PositiveSafeIntegerSchema,
        rate: BoundedRateBudgetSchema.optional(),
      })
      .strict(),
    // One ceiling for every key, or one resolved from the key — never both.
    //
    // The `never` members are what make that exclusive to the COMPILER. Without them the union
    // refuses a mixed shape only at construction, because an excess-property check against a
    // union admits any property some member declares — so `{ maxKeys, maxConcurrent, limits }`
    // typechecks and throws when the admission is built. A consuming session found the cost of
    // that: their tests happened to construct an admission, so it surfaced; on a path exercised
    // only in production it would have surfaced there. `limits?: never` on the flat branch and
    // `maxConcurrent?: never` / `rate?: never` on the resolver branch move the refusal to `tsc`
    // and change nothing at runtime, where both branches already refused it.
    perKey: z
      .union([
        z
          .object({
            maxConcurrent: PositiveSafeIntegerSchema,
            maxKeys: PositiveSafeIntegerSchema,
            rate: BoundedRateBudgetSchema.optional(),
            limits: z.never().optional(),
          })
          .strict(),
        z
          .object({
            maxKeys: PositiveSafeIntegerSchema,
            limits: PerKeyLimitResolverSchema,
            maxConcurrent: z.never().optional(),
            rate: z.never().optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .readonly();
export type BoundedAdmissionPolicy = z.infer<typeof BoundedAdmissionPolicySchema>;

export const BoundedAdmissionStateSchema = z.enum(['accepting', 'draining', 'closed']);
export type BoundedAdmissionState = z.infer<typeof BoundedAdmissionStateSchema>;

export const BoundedAdmissionRefusalReasonSchema = z.enum([
  'not-accepting',
  'global-concurrency',
  'key-required',
  'key-capacity',
  'key-concurrency',
  'global-rate',
  'key-rate',
  'upstream',
]);
export type BoundedAdmissionRefusalReason = z.infer<
  typeof BoundedAdmissionRefusalReasonSchema
>;

const RefusalCountersSchema = z
  .object({
    'not-accepting': z.number().int().nonnegative(),
    'global-concurrency': z.number().int().nonnegative(),
    'key-required': z.number().int().nonnegative(),
    'key-capacity': z.number().int().nonnegative(),
    'key-concurrency': z.number().int().nonnegative(),
    'global-rate': z.number().int().nonnegative(),
    'key-rate': z.number().int().nonnegative(),
    upstream: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const BoundedAdmissionSnapshotSchema = z
  .object({
    state: BoundedAdmissionStateSchema,
    active: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    released: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    keys: z.number().int().nonnegative(),
    globalRateSamples: z.number().int().nonnegative(),
    keyRateSamples: z.number().int().nonnegative(),
    refusals: RefusalCountersSchema,
  })
  .strict()
  .readonly();
export type BoundedAdmissionSnapshot = z.infer<typeof BoundedAdmissionSnapshotSchema>;

export interface BoundedAdmissionClock {
  now(): number;
}

export interface BoundedAdmissionConfig {
  readonly policy: BoundedAdmissionPolicy;
  /** Compose with application readiness/lifecycle admission. */
  readonly upstream?: ApplicationAdmission;
  /** Monotonic milliseconds. Default `performance.now()`. */
  readonly clock?: BoundedAdmissionClock;
}

export interface BoundedOperationLease extends ApplicationOperationLease {
  readonly key?: string;
}

export interface BoundedAdmissionLeaseResult {
  readonly outcome: 'leased';
  readonly lease: BoundedOperationLease;
}

export interface BoundedAdmissionRefusedResult {
  readonly outcome: 'refused';
  readonly reason: BoundedAdmissionRefusalReason;
  /** Present only for a rate budget whose oldest sample gives a real bound. */
  readonly retryAfterMs?: number;
}

export type BoundedAdmissionResult =
  | BoundedAdmissionLeaseResult
  | BoundedAdmissionRefusedResult;

export interface BoundedOperationRunContext {
  readonly signal: AbortSignal;
}

export interface BoundedOperationRunOptions {
  readonly signal?: AbortSignal;
  /** Caller wait budget. It never shortens the underlying lease lifetime. */
  readonly timeoutMs?: number;
}

export interface BoundedAdmissionDrainOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface BoundedAdmissionDrainResult {
  readonly drained: boolean;
  readonly remaining: number;
}

export interface BoundedAdmissionForceResult {
  /** Work still physically active. `force()` does not pretend to terminate it. */
  readonly remaining: number;
}

export interface BoundedAdmission {
  acquire(key?: string): BoundedAdmissionResult;
  run<T>(
    key: string | undefined,
    work: (context: BoundedOperationRunContext) => T | Promise<T>,
    options?: BoundedOperationRunOptions,
  ): Promise<T>;
  stopAdmission(): BoundedAdmissionSnapshot;
  drain(options?: BoundedAdmissionDrainOptions): Promise<BoundedAdmissionDrainResult>;
  force(): BoundedAdmissionForceResult;
  getSnapshot(): BoundedAdmissionSnapshot;
}

export class BoundedAdmissionRefusalError extends Error {
  constructor(
    public readonly reason: BoundedAdmissionRefusalReason,
    public readonly retryAfterMs?: number,
  ) {
    super(`Bounded admission refused: ${reason}`);
    this.name = 'BoundedAdmissionRefusalError';
  }
}

export class BoundedOperationWaitError extends Error {
  constructor(public readonly reason: 'cancelled' | 'timed-out') {
    super(
      reason === 'cancelled' ? 'Operation wait was cancelled' : 'Operation wait timed out',
    );
    this.name = 'BoundedOperationWaitError';
  }
}

const NO_REFUSALS: Readonly<Record<BoundedAdmissionRefusalReason, number>> = {
  'not-accepting': 0,
  'global-concurrency': 0,
  'key-required': 0,
  'key-capacity': 0,
  'key-concurrency': 0,
  'global-rate': 0,
  'key-rate': 0,
  upstream: 0,
};

/** Wait until the last lease is released, or until the timeout or the signal. */
async function waitForDrain(
  drainWaiters: Set<() => void>,
  options: BoundedAdmissionDrainOptions,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (): void => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  if (options.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
      throw new TypeError('drain timeoutMs must be a non-negative safe integer');
    }
    timer = setTimeout(abort, options.timeoutMs);
  }
  let resolveDrained: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        resolveDrained = resolve;
        drainWaiters.add(resolve);
      }),
      new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (resolveDrained) drainWaiters.delete(resolveDrained);
  }
}

/** Process-local, no-queue admission with explicit finite concurrency/rate budgets. */
export function createBoundedAdmission(config: BoundedAdmissionConfig): BoundedAdmission {
  const policy = BoundedAdmissionPolicySchema.parse(config.policy);
  const clock = config.clock ?? { now: () => performance.now() };
  const keys = new Map<string, KeyRecord>();
  const globalRate: RateSample[] = [];
  const drainWaiters = new Set<() => void>();
  const refusals: Record<BoundedAdmissionRefusalReason, number> = { ...NO_REFUSALS };
  let state: BoundedAdmissionState = 'accepting';
  let active = 0;
  let accepted = 0;
  let released = 0;
  let refused = 0;
  let lastNow = Number.NEGATIVE_INFINITY;

  const now = (): number => {
    const value = clock.now();
    if (!Number.isFinite(value)) throw new TypeError('Bounded admission clock must be finite');
    if (value < lastNow) throw new Error('Bounded admission clock moved backwards');
    lastNow = value;
    return value;
  };

  /**
   * The ceiling for one key, taken from whichever form the policy declares.
   *
   * A resolver's answer goes through the same schema as a declared limit, so a resolver reading
   * configuration cannot install a ceiling the policy itself would have refused.
   */
  const resolveKeyLimits = (key: string): BoundedAdmissionPerKeyLimits | undefined => {
    const perKey = policy.perKey;
    if (!perKey) return undefined;
    // Narrowed on the resolver itself rather than on the key: both branches now declare
    // `limits`, one of them as `never`, so `'limits' in perKey` no longer tells them apart.
    const resolver = perKey.limits;
    if (resolver) return BoundedAdmissionPerKeyLimitsSchema.parse(resolver(key));
    return BoundedAdmissionPerKeyLimitsSchema.parse({
      maxConcurrent: perKey.maxConcurrent,
      ...(perKey.rate && { rate: perKey.rate }),
    });
  };

  const prune = (at: number): void => pruneExpired(policy, globalRate, keys, at);

  const refuse = (
    reason: BoundedAdmissionRefusalReason,
    retryAfterMs?: number,
  ): BoundedAdmissionRefusedResult => {
    refused += 1;
    refusals[reason] += 1;
    return {
      outcome: 'refused',
      reason,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    };
  };

  const closeIfDrained = (): void => {
    if (state !== 'draining' || active !== 0) return;
    state = 'closed';
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };

  const rollbackReservation = (
    key: string | undefined,
    keyRecord: KeyRecord | undefined,
    globalSample: RateSample | undefined,
    keySample: RateSample | undefined,
  ): void => {
    active -= 1;
    if (keyRecord) keyRecord.active -= 1;
    removeSample(globalRate, globalSample);
    if (keyRecord) removeSample(keyRecord.rate, keySample);
    if (key !== undefined && keyRecord?.active === 0 && keyRecord.rate.length === 0) {
      keys.delete(key);
    }
  };

  const acquire = (key?: string): BoundedAdmissionResult => {
    const at = now();
    prune(at);
    if (state !== 'accepting') return refuse('not-accepting');
    if (active >= policy.global.maxConcurrent) return refuse('global-concurrency');
    if (policy.perKey && key === undefined) return refuse('key-required');

    let keyRecord = key === undefined ? undefined : keys.get(key);
    if (policy.perKey && key !== undefined) {
      if (!keyRecord && keys.size >= policy.perKey.maxKeys) return refuse('key-capacity');
      if (keyRecord?.limits && keyRecord.active >= keyRecord.limits.maxConcurrent) {
        return refuse('key-concurrency');
      }
    }

    if (policy.global.rate && globalRate.length >= policy.global.rate.limit) {
      return refuse('global-rate', retryAfter(globalRate, policy.global.rate, at));
    }
    const keyRate = keyRecord?.limits?.rate;
    if (keyRate && keyRecord && keyRecord.rate.length >= keyRate.limit) {
      return refuse('key-rate', retryAfter(keyRecord.rate, keyRate, at));
    }

    if (key !== undefined && !keyRecord) {
      keyRecord = { active: 0, rate: [], limits: resolveKeyLimits(key) };
      keys.set(key, keyRecord);
    }
    const globalSample = policy.global.rate ? { at } : undefined;
    const keySample = keyRecord?.limits?.rate ? { at } : undefined;
    active += 1;
    if (keyRecord) keyRecord.active += 1;
    if (globalSample) globalRate.push(globalSample);
    if (keySample && keyRecord) keyRecord.rate.push(keySample);

    const upstreamLease = config.upstream?.acquire();
    if (config.upstream && !upstreamLease) {
      rollbackReservation(key, keyRecord, globalSample, keySample);
      return refuse('upstream');
    }

    accepted += 1;
    let leaseReleased = false;
    const lease: BoundedOperationLease = {
      ...(key !== undefined && { key }),
      get released() {
        return leaseReleased;
      },
      release() {
        if (leaseReleased) return;
        leaseReleased = true;
        active -= 1;
        if (keyRecord) keyRecord.active -= 1;
        released += 1;
        if (key !== undefined && keyRecord?.active === 0 && keyRecord.rate.length === 0) {
          keys.delete(key);
        }
        // Own accounting changes first: an upstream release may synchronously
        // notify a listener that attempts another acquisition.
        upstreamLease?.release();
        closeIfDrained();
      },
    };
    return { outcome: 'leased', lease };
  };

  const getSnapshot = (): BoundedAdmissionSnapshot => {
    const at = now();
    prune(at);
    let keyRateSamples = 0;
    for (const record of keys.values()) keyRateSamples += record.rate.length;
    return BoundedAdmissionSnapshotSchema.parse({
      state,
      active,
      accepted,
      released,
      refused,
      keys: keys.size,
      globalRateSamples: globalRate.length,
      keyRateSamples,
      refusals,
    });
  };

  const stopAdmission = (): BoundedAdmissionSnapshot => {
    if (state === 'accepting') state = 'draining';
    closeIfDrained();
    return getSnapshot();
  };

  const drain = async (
    options: BoundedAdmissionDrainOptions = {},
  ): Promise<BoundedAdmissionDrainResult> => {
    stopAdmission();
    if (active === 0) return { drained: true, remaining: 0 };
    await waitForDrain(drainWaiters, options);
    return { drained: active === 0, remaining: active };
  };

  const run = <T>(
    key: string | undefined,
    work: (context: BoundedOperationRunContext) => T | Promise<T>,
    options: BoundedOperationRunOptions = {},
  ): Promise<T> => runAdmitted(acquire, key, work, options);

  return {
    acquire,
    run,
    stopAdmission,
    drain,
    force() {
      if (state === 'accepting') state = 'draining';
      state = 'closed';
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
      return { remaining: active };
    },
    getSnapshot,
  };
}
