import { z } from 'zod';
import type { ApplicationAdmission, ApplicationOperationLease } from './kernel';

const PositiveSafeIntegerSchema = z.number().int().positive().safe();

export const BoundedRateBudgetSchema = z
  .object({
    limit: PositiveSafeIntegerSchema,
    intervalMs: PositiveSafeIntegerSchema,
  })
  .strict()
  .readonly();
export type BoundedRateBudget = z.infer<typeof BoundedRateBudgetSchema>;

export const BoundedAdmissionPolicySchema = z
  .object({
    global: z
      .object({
        maxConcurrent: PositiveSafeIntegerSchema,
        rate: BoundedRateBudgetSchema.optional(),
      })
      .strict(),
    perKey: z
      .object({
        maxConcurrent: PositiveSafeIntegerSchema,
        maxKeys: PositiveSafeIntegerSchema,
        rate: BoundedRateBudgetSchema.optional(),
      })
      .strict()
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

interface RateSample {
  readonly at: number;
}

interface KeyRecord {
  active: number;
  readonly rate: RateSample[];
}

/** Process-local, no-queue admission with explicit finite concurrency/rate budgets. */
export function createBoundedAdmission(config: BoundedAdmissionConfig): BoundedAdmission {
  const policy = BoundedAdmissionPolicySchema.parse(config.policy);
  const clock = config.clock ?? { now: () => performance.now() };
  const keys = new Map<string, KeyRecord>();
  const globalRate: RateSample[] = [];
  const drainWaiters = new Set<() => void>();
  const refusals: Record<BoundedAdmissionRefusalReason, number> = {
    'not-accepting': 0,
    'global-concurrency': 0,
    'key-required': 0,
    'key-capacity': 0,
    'key-concurrency': 0,
    'global-rate': 0,
    'key-rate': 0,
    upstream: 0,
  };
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

  const pruneRate = (samples: RateSample[], intervalMs: number, at: number): void => {
    let expired = 0;
    while (expired < samples.length && at - (samples[expired]?.at ?? at) >= intervalMs) {
      expired += 1;
    }
    if (expired > 0) samples.splice(0, expired);
  };

  const prune = (at: number): void => {
    if (policy.global.rate) pruneRate(globalRate, policy.global.rate.intervalMs, at);
    for (const [key, record] of keys) {
      if (policy.perKey?.rate) {
        pruneRate(record.rate, policy.perKey.rate.intervalMs, at);
      }
      if (record.active === 0 && record.rate.length === 0) keys.delete(key);
    }
  };

  const retryAfter = (samples: RateSample[], budget: BoundedRateBudget, at: number): number =>
    Math.max(1, Math.ceil(budget.intervalMs - (at - (samples[0]?.at ?? at))));

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
    if (globalSample) {
      const index = globalRate.indexOf(globalSample);
      if (index >= 0) globalRate.splice(index, 1);
    }
    if (keySample && keyRecord) {
      const index = keyRecord.rate.indexOf(keySample);
      if (index >= 0) keyRecord.rate.splice(index, 1);
    }
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
      if (keyRecord && keyRecord.active >= policy.perKey.maxConcurrent) {
        return refuse('key-concurrency');
      }
    }

    if (policy.global.rate && globalRate.length >= policy.global.rate.limit) {
      return refuse('global-rate', retryAfter(globalRate, policy.global.rate, at));
    }
    if (
      policy.perKey?.rate &&
      keyRecord &&
      keyRecord.rate.length >= policy.perKey.rate.limit
    ) {
      return refuse('key-rate', retryAfter(keyRecord.rate, policy.perKey.rate, at));
    }

    if (key !== undefined && !keyRecord) {
      keyRecord = { active: 0, rate: [] };
      keys.set(key, keyRecord);
    }
    const globalSample = policy.global.rate ? { at } : undefined;
    const keySample = policy.perKey?.rate && keyRecord ? { at } : undefined;
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
    return { drained: active === 0, remaining: active };
  };

  const run = async <T>(
    key: string | undefined,
    work: (context: BoundedOperationRunContext) => T | Promise<T>,
    options: BoundedOperationRunOptions = {},
  ): Promise<T> => {
    if (options.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
        throw new TypeError('run timeoutMs must be a non-negative safe integer');
      }
    }
    if (options.signal?.aborted) throw new BoundedOperationWaitError('cancelled');
    const admission = acquire(key);
    if (admission.outcome === 'refused') {
      throw new BoundedAdmissionRefusalError(admission.reason, admission.retryAfterMs);
    }

    const workAbort = new AbortController();
    const abortWork = (): void => workAbort.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortWork, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        workAbort.abort(new DOMException('Operation wait timed out', 'TimeoutError'));
      }, options.timeoutMs);
    }

    const outcome = Promise.resolve()
      .then(() => work({ signal: workAbort.signal }))
      .then(
        (value) => ({ kind: 'value' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      )
      .finally(() => admission.lease.release());
    const callerDone = new Promise<{ kind: 'caller' }>((resolve) => {
      const settle = (): void => resolve({ kind: 'caller' });
      if (workAbort.signal.aborted) settle();
      else workAbort.signal.addEventListener('abort', settle, { once: true });
    });

    try {
      const settled = await Promise.race([outcome, callerDone]);
      if (settled.kind === 'caller') {
        throw new BoundedOperationWaitError(timedOut ? 'timed-out' : 'cancelled');
      }
      if (settled.kind === 'error') throw settled.error;
      return settled.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortWork);
    }
  };

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
