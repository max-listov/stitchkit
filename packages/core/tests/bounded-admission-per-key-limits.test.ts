import { describe, expect, test } from 'bun:test';
import { createBoundedAdmission } from '../src/application/admission';

function manualClock(): { now(): number; advance(ms: number): void } {
  let value = 0;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

describe('per-key admission with a key-dependent ceiling', () => {
  test('enforces a different ceiling for each key from one resolver', () => {
    const ceilings: Record<string, number> = { wide: 3, narrow: 1 };
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 10 },
        perKey: {
          maxKeys: 4,
          limits: (key) => ({ maxConcurrent: ceilings[key] ?? 2 }),
        },
      },
    });

    expect(admission.acquire('narrow').outcome).toBe('leased');
    expect(admission.acquire('narrow')).toMatchObject({
      outcome: 'refused',
      reason: 'key-concurrency',
    });

    // The same admission, the same call, a different ceiling — which is the whole point.
    for (let index = 0; index < 3; index += 1) {
      expect(admission.acquire('wide').outcome).toBe('leased');
    }
    expect(admission.acquire('wide')).toMatchObject({
      outcome: 'refused',
      reason: 'key-concurrency',
    });

    // A key the resolver does not know still gets whatever the resolver decides for it.
    expect(admission.acquire('other').outcome).toBe('leased');
    expect(admission.acquire('other').outcome).toBe('leased');
    expect(admission.acquire('other')).toMatchObject({
      outcome: 'refused',
      reason: 'key-concurrency',
    });
  });

  test('resolves a rate budget per key and keeps the aggregate snapshot intact', () => {
    const clock = manualClock();
    const admission = createBoundedAdmission({
      clock,
      policy: {
        global: { maxConcurrent: 10 },
        perKey: {
          maxKeys: 4,
          limits: (key) => ({
            maxConcurrent: 10,
            rate: { limit: key === 'slow' ? 1 : 3, intervalMs: 1_000 },
          }),
        },
      },
    });

    expect(admission.acquire('slow').outcome).toBe('leased');
    const refused = admission.acquire('slow');
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'key-rate' });
    if (refused.outcome !== 'refused') throw new Error('expected a refusal');
    expect(refused.retryAfterMs).toBe(1_000);

    expect(admission.acquire('fast').outcome).toBe('leased');
    expect(admission.acquire('fast').outcome).toBe('leased');

    expect(admission.getSnapshot()).toMatchObject({
      state: 'accepting',
      active: 3,
      accepted: 3,
      refused: 1,
      refusals: { 'key-rate': 1, 'key-concurrency': 0 },
    });

    // The interval that expires the sample is the one this key resolved, not a shared default.
    clock.advance(1_000);
    expect(admission.acquire('slow').outcome).toBe('leased');
  });

  test('eviction under maxKeys drops the cached ceiling with the record', () => {
    const resolved: string[] = [];
    let ceiling = 1;
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 10 },
        perKey: {
          maxKeys: 2,
          limits: (key) => {
            resolved.push(key);
            return { maxConcurrent: ceiling };
          },
        },
      },
    });

    const first = admission.acquire('tenant');
    if (first.outcome !== 'leased') throw new Error('expected admission');
    expect(resolved).toEqual(['tenant']);

    // A second admission of a live key reuses the cached ceiling rather than resolving again.
    expect(admission.acquire('tenant')).toMatchObject({ reason: 'key-concurrency' });
    expect(resolved).toEqual(['tenant']);

    // Releasing the last lease evicts the record, so the next admission resolves afresh — which
    // is also the documented way a changed configuration is adopted.
    first.lease.release();
    ceiling = 2;
    expect(admission.acquire('tenant').outcome).toBe('leased');
    expect(admission.acquire('tenant').outcome).toBe('leased');
    expect(resolved).toEqual(['tenant', 'tenant']);
  });

  test('a resolver and a flat ceiling are mutually exclusive, to the compiler first', () => {
    expect(() =>
      createBoundedAdmission({
        policy: {
          global: { maxConcurrent: 1 },
          // @ts-expect-error the two forms are exclusive in the type, not only in the schema
          perKey: { maxKeys: 1, maxConcurrent: 1, limits: () => ({ maxConcurrent: 1 }) },
        },
      }),
    ).toThrow();

    // A resolver's answer is validated like a declared limit, so it cannot install a ceiling the
    // policy schema would have refused.
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 1 },
        perKey: { maxKeys: 1, limits: () => ({ maxConcurrent: 0 }) },
      },
    });
    expect(() => admission.acquire('any')).toThrow();
  });
});
