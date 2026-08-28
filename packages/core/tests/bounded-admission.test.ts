import { describe, expect, test } from 'bun:test';
import {
  BoundedAdmissionRefusalError,
  BoundedOperationWaitError,
  createBoundedAdmission,
} from '../src/application/admission';
import { createApplication } from '../src/application/kernel';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('bounded operation admission', () => {
  test('global and per-key permits are atomic and release exactly once', () => {
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 2 },
        perKey: { maxConcurrent: 1, maxKeys: 2 },
      },
    });
    const a = admission.acquire('a');
    expect(a.outcome).toBe('leased');
    expect(admission.acquire('a')).toMatchObject({
      outcome: 'refused',
      reason: 'key-concurrency',
    });
    const b = admission.acquire('b');
    expect(b.outcome).toBe('leased');
    expect(admission.acquire('c')).toMatchObject({
      outcome: 'refused',
      reason: 'global-concurrency',
    });

    if (a.outcome === 'leased') {
      a.lease.release();
      a.lease.release();
      expect(a.lease.released).toBe(true);
    }
    if (b.outcome === 'leased') b.lease.release();
    expect(admission.getSnapshot()).toMatchObject({
      active: 0,
      accepted: 2,
      released: 2,
      refused: 2,
      keys: 0,
    });
  });

  test('rate windows give retryAfter and retire bounded key state', () => {
    let time = 100;
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 10, rate: { limit: 3, intervalMs: 1_000 } },
        perKey: {
          maxConcurrent: 2,
          maxKeys: 2,
          rate: { limit: 1, intervalMs: 500 },
        },
      },
      clock: { now: () => time },
    });
    const first = admission.acquire('one');
    expect(first.outcome).toBe('leased');
    if (first.outcome === 'leased') first.lease.release();
    expect(admission.acquire('one')).toEqual({
      outcome: 'refused',
      reason: 'key-rate',
      retryAfterMs: 500,
    });
    const second = admission.acquire('two');
    expect(second.outcome).toBe('leased');
    if (second.outcome === 'leased') second.lease.release();
    expect(admission.acquire('three')).toMatchObject({
      outcome: 'refused',
      reason: 'key-capacity',
    });

    time += 500;
    const third = admission.acquire('three');
    expect(third.outcome).toBe('leased');
    if (third.outcome === 'leased') third.lease.release();
    expect(admission.getSnapshot().keys).toBe(1);

    time += 1_000;
    expect(admission.getSnapshot()).toMatchObject({
      keys: 0,
      globalRateSamples: 0,
      keyRateSamples: 0,
    });
  });

  test('an upstream refusal rolls every local reservation and rate sample back', () => {
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 1, rate: { limit: 1, intervalMs: 1_000 } },
        perKey: {
          maxConcurrent: 1,
          maxKeys: 1,
          rate: { limit: 1, intervalMs: 1_000 },
        },
      },
      upstream: {
        acquire: () => null,
        run: async () => {
          throw new Error('not used');
        },
      },
    });
    expect(admission.acquire('a')).toEqual({ outcome: 'refused', reason: 'upstream' });
    expect(admission.getSnapshot()).toMatchObject({
      active: 0,
      accepted: 0,
      keys: 0,
      globalRateSamples: 0,
      keyRateSamples: 0,
    });
  });

  test('caller timeout settles without releasing non-cooperative underlying work', async () => {
    const work = deferred<string>();
    const admission = createBoundedAdmission({
      policy: { global: { maxConcurrent: 1 } },
    });
    const call = admission.run(undefined, () => work.promise, { timeoutMs: 5 });
    await expect(call).rejects.toEqual(new BoundedOperationWaitError('timed-out'));
    expect(admission.getSnapshot().active).toBe(1);
    expect(admission.acquire()).toMatchObject({
      outcome: 'refused',
      reason: 'global-concurrency',
    });

    work.resolve('late');
    await Bun.sleep(0);
    expect(admission.getSnapshot()).toMatchObject({ active: 0, released: 1 });
  });

  test('sync throws release, refusal throws a reasoned run error', async () => {
    const admission = createBoundedAdmission({
      policy: { global: { maxConcurrent: 1 } },
    });
    await expect(
      admission.run(undefined, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(admission.getSnapshot().active).toBe(0);

    const held = admission.acquire();
    expect(held.outcome).toBe('leased');
    await expect(admission.run(undefined, () => undefined)).rejects.toEqual(
      new BoundedAdmissionRefusalError('global-concurrency'),
    );
    if (held.outcome === 'leased') held.lease.release();
  });

  test('drain waits for real work and force only reports what remains', async () => {
    const admission = createBoundedAdmission({
      policy: { global: { maxConcurrent: 2 } },
    });
    const lease = admission.acquire();
    expect(lease.outcome).toBe('leased');
    const firstDrain = admission.drain({ timeoutMs: 5 });
    await expect(firstDrain).resolves.toEqual({ drained: false, remaining: 1 });
    expect(admission.acquire()).toMatchObject({
      outcome: 'refused',
      reason: 'not-accepting',
    });
    expect(admission.force()).toEqual({ remaining: 1 });
    expect(admission.getSnapshot()).toMatchObject({ state: 'closed', active: 1 });
    if (lease.outcome === 'leased') lease.lease.release();
    expect(admission.getSnapshot()).toMatchObject({ state: 'closed', active: 0 });
  });

  test('the existing application admission is an upstream readiness boundary', async () => {
    const application = createApplication({ id: 'bounded-admission-test' });
    await application.start();
    const admission = createBoundedAdmission({
      policy: { global: { maxConcurrent: 1 } },
      upstream: application.admission,
    });
    const lease = admission.acquire();
    expect(lease.outcome).toBe('leased');
    expect(application.getSnapshot().admission.pending).toBe(1);
    if (lease.outcome === 'leased') lease.lease.release();
    expect(application.getSnapshot().admission.pending).toBe(0);
    await application.shutdown({ gracePeriodMs: 0, forceTimeoutMs: 0 });
    expect(admission.acquire()).toMatchObject({ outcome: 'refused', reason: 'upstream' });
  });
});
