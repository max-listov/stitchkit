/** Thread leases under a fence, and turn reports applied once. */
import { describe, expect, test } from 'bun:test';
import { defineAgentExecutorContract } from '../../src/agent-executor/contract';
import {
  claimThread,
  createExecutorLeases,
  EMPTY_EXECUTOR_LEASES,
  ExecutorLeaseRefusal,
  memoryExecutorLeaseStore,
  renewThread,
} from '../../src/agent-executor/leases';
import { EXECUTOR_ERRORS } from '../../src/entrypoints/agent-executor';
import { AppError } from '../../src/entrypoints/contract';
import { createHandler, implement } from '../../src/entrypoints/server';

function leases() {
  let now = 1_000;
  const service = createExecutorLeases({
    store: memoryExecutorLeaseStore(),
    now: () => now,
    ttlMs: 30_000,
  });
  return { service, advance: (ms: number) => (now += ms) };
}
const claim = (instance: string) => ({
  threadId: 'th',
  executorId: 'mac',
  instance,
  profileId: 'p',
});
const report = (
  instance: string,
  fence: number,
  executorSeq: number,
  phase = 'dispatching' as const,
) => ({
  turnId: 't',
  threadId: 'th',
  turnOrdinal: 1,
  instance,
  fence,
  executorSeq,
  phase,
  deltas: [],
});

describe('thread leases', () => {
  test('a second instance gets no thread until the first releases it', async () => {
    const { service } = leases();
    const first = await service.claim(claim('a'));
    const refused = await service.claim(claim('b')).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ExecutorLeaseRefusal);
    expect(AppError.is(refused)).toBe(true);
    expect(refused).toMatchObject({ status: 409, code: EXECUTOR_ERRORS.threadLeased });
    await service.release({ threadId: 'th', instance: 'a', fence: first.fence });
    const second = await service.claim(claim('b'));
    expect(second.fence).toBe(first.fence + 1);
  });

  test('a lease that ran out on the server clock goes to the next instance under a new fence', async () => {
    const { service, advance } = leases();
    const first = await service.claim(claim('a'));
    advance(30_001);
    expect((await service.claim(claim('b'))).fence).toBe(first.fence + 1);
  });

  test('a report under the old fence is refused as stale', async () => {
    const { service } = leases();
    const first = await service.claim(claim('a'));
    await service.release({ threadId: 'th', instance: 'a', fence: first.fence });
    await service.claim(claim('b'));
    await expect(service.report(report('a', first.fence, 1))).rejects.toMatchObject({
      code: 'EXECUTOR_FENCE_STALE',
    });
  });

  test('the same instance under a lease it lost and took again cannot report under the lost fence', async () => {
    const { service, advance } = leases();
    const lost = await service.claim(claim('a'));
    advance(30_001);
    const retaken = await service.claim(claim('a'));
    expect(retaken.fence).toBe(lost.fence + 1);
    await expect(service.report(report('a', lost.fence, 1))).rejects.toMatchObject({
      code: 'EXECUTOR_FENCE_STALE',
    });
    expect(await service.report(report('a', retaken.fence, 1))).toEqual({
      outcome: 'applied',
      ackedSeq: 1,
    });
  });

  test('the same instance under a lease it lost and took again cannot release it under the lost fence', async () => {
    const { service, advance } = leases();
    const lost = await service.claim(claim('a'));
    advance(30_001);
    const retaken = await service.claim(claim('a'));
    expect(
      await service.release({ threadId: 'th', instance: 'a', fence: lost.fence }),
    ).toEqual({ released: false });
    // The live lease is untouched: another instance is still refused, and it renews.
    await expect(service.claim(claim('b'))).rejects.toMatchObject({
      code: EXECUTOR_ERRORS.threadLeased,
    });
    expect(
      await service.renew({ threadId: 'th', instance: 'a', fence: retaken.fence }),
    ).toMatchObject({ fence: retaken.fence });
  });

  test('another executor or profile is refused for good', async () => {
    const { service, advance } = leases();
    await service.claim(claim('a'));
    advance(60_000);
    await expect(service.claim({ ...claim('a'), executorId: 'other' })).rejects.toMatchObject({
      code: 'EXECUTOR_THREAD_LEASED',
    });
  });

  test('a resent report is applied once, and a terminal phase is never left', async () => {
    const { service } = leases();
    const { fence } = await service.claim(claim('a'));
    expect(await service.report(report('a', fence, 1))).toEqual({
      outcome: 'applied',
      ackedSeq: 1,
    });
    expect(await service.report(report('a', fence, 1))).toEqual({
      outcome: 'duplicate',
      ackedSeq: 1,
    });
    await service.report({ ...report('a', fence, 2), phase: 'delivered' });
    await service.report({ ...report('a', fence, 3), phase: 'interrupted' });
    await expect(
      service.report({ ...report('a', fence, 4), phase: 'completed' }),
    ).rejects.toMatchObject({ code: EXECUTOR_ERRORS.invalidPhase });
  });

  test('a report on another thread cannot overwrite an existing turn id', async () => {
    const { service } = leases();
    const a = await service.claim(claim('a'));
    const b = await service.claim({ ...claim('b'), threadId: 'th-other' });
    await service.report(report('a', a.fence, 1));
    await expect(
      service.report({ ...report('b', b.fence, 2), threadId: 'th-other', phase: 'failed' }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_UNKNOWN_TURN' });
  });

  test('releasing an already-released or expired lease returns released: false', async () => {
    const { service, advance } = leases();
    const first = await service.claim(claim('a'));
    expect(
      await service.release({ threadId: 'th', instance: 'a', fence: first.fence }),
    ).toEqual({ released: true });
    expect(
      await service.release({ threadId: 'th', instance: 'a', fence: first.fence }),
    ).toEqual({ released: false });
    const second = await service.claim(claim('b'));
    advance(30_001);
    expect(
      await service.release({ threadId: 'th', instance: 'b', fence: second.fence }),
    ).toEqual({ released: false });
  });

  test('non-positive, fractional, past-the-timer-ceiling, or missing ttlMs is refused', () => {
    // A range error for a number the timer rule refuses, a type error for no number at all.
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 31,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        createExecutorLeases({ store: memoryExecutorLeaseStore(), now: () => 0, ttlMs: bad }),
      ).toThrow(RangeError);
      expect(() => claimThread(EMPTY_EXECUTOR_LEASES, claim('a'), 1_000, bad)).toThrow(
        RangeError,
      );
      const claimed = claimThread(EMPTY_EXECUTOR_LEASES, claim('a'), 1_000, 30_000);
      expect(() =>
        renewThread(claimed.state, { threadId: 'th', instance: 'a', fence: 1 }, 2_000, bad),
      ).toThrow(RangeError);
    }
    expect(() =>
      Reflect.apply(createExecutorLeases, undefined, [
        { store: memoryExecutorLeaseStore(), now: () => 0, ttlMs: undefined },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(claimThread, undefined, [
        EMPTY_EXECUTOR_LEASES,
        claim('a'),
        1_000,
        undefined,
      ]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(renewThread, undefined, [
        EMPTY_EXECUTOR_LEASES,
        { threadId: 'th', instance: 'a', fence: 1 },
        1_000,
        undefined,
      ]),
    ).toThrow(TypeError);
  });

  test('end-to-end HTTP contract handler validates claim, renew, report and release strictly', async () => {
    let now = 1_000;
    const service = createExecutorLeases({
      store: memoryExecutorLeaseStore(),
      now: () => now,
      ttlMs: 30_000,
    });
    const contract = defineAgentExecutorContract({ scope: 'admin' });
    // The service is mounted as it is: a refusal reaches the wire with its own status and code.
    const handler = createHandler({
      services: [
        implement(contract, {
          hello: () => ({ protocol: 1, resumable: [] }),
          claim: (ctx) => service.claim(ctx.input),
          renew: (ctx) => service.renew(ctx.input),
          release: (ctx) => service.release(ctx.input),
          report: (ctx) => service.report(ctx.input),
        }),
      ],
    });
    const post = async (path: string, body: unknown) => {
      const response = await handler(
        new Request(`http://localhost/agent-executor${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: await response.json() };
    };

    // Claim thread -> expiresAtMs = 31_000
    const claimed = await post('/threads/claim', claim('a'));
    expect(claimed).toEqual({
      status: 200,
      body: { threadId: 'th', fence: 1, ttlMs: 30_000 },
    });

    // Another instance while the lease is live -> EXECUTOR_THREAD_LEASED
    const leasedElsewhere = await post('/threads/claim', claim('b'));
    expect(leasedElsewhere.status).toBe(409);
    expect(leasedElsewhere.body).toMatchObject({
      error: { code: EXECUTOR_ERRORS.threadLeased },
    });

    // Renew while live -> expiresAtMs = 51_000
    now += 20_000;
    const renewed = await post('/threads/renew', { threadId: 'th', instance: 'a', fence: 1 });
    expect(renewed).toEqual({
      status: 200,
      body: { threadId: 'th', fence: 1, ttlMs: 30_000 },
    });

    // Renew with stale fence -> refused
    const staleRenew = await post('/threads/renew', {
      threadId: 'th',
      instance: 'a',
      fence: 2,
    });
    expect(staleRenew.status).toBe(409);
    expect(staleRenew.body).toMatchObject({ error: { code: 'EXECUTOR_FENCE_STALE' } });

    // Report turn: the first is applied, its resend a duplicate
    const firstReport = await post('/turns/report', report('a', 1, 1, 'dispatching'));
    expect(firstReport).toEqual({ status: 200, body: { outcome: 'applied', ackedSeq: 1 } });

    const duplicateReport = await post('/turns/report', report('a', 1, 1, 'dispatching'));
    expect(duplicateReport).toEqual({
      status: 200,
      body: { outcome: 'duplicate', ackedSeq: 1 },
    });

    // Invalid phase jump (dispatching -> completed) -> EXECUTOR_INVALID_PHASE
    const skippedDelivered = await post('/turns/report', {
      ...report('a', 1, 2),
      phase: 'completed',
    });
    expect(skippedDelivered.status).toBe(409);
    expect(skippedDelivered.body).toMatchObject({
      error: { code: EXECUTOR_ERRORS.invalidPhase },
    });

    // Valid progression: dispatching -> delivered -> completed
    const delivered = await post('/turns/report', {
      ...report('a', 1, 2),
      phase: 'delivered',
    });
    expect(delivered).toEqual({ status: 200, body: { outcome: 'applied', ackedSeq: 2 } });

    const completed = await post('/turns/report', {
      ...report('a', 1, 3),
      phase: 'completed',
    });
    expect(completed).toEqual({ status: 200, body: { outcome: 'applied', ackedSeq: 3 } });

    // Leaving a terminal phase -> EXECUTOR_INVALID_PHASE
    const invalidPhase = await post('/turns/report', {
      ...report('a', 1, 4),
      phase: 'delivered',
    });
    expect(invalidPhase.status).toBe(409);
    expect(invalidPhase.body).toMatchObject({ error: { code: EXECUTOR_ERRORS.invalidPhase } });

    // Cross-thread mismatch -> EXECUTOR_UNKNOWN_TURN
    const otherClaim = await post('/threads/claim', { ...claim('b'), threadId: 'th-other' });
    expect(otherClaim.status).toBe(200);
    const crossThread = await post('/turns/report', {
      ...report('b', 1, 4),
      threadId: 'th-other',
      phase: 'failed',
    });
    expect(crossThread.status).toBe(409);
    expect(crossThread.body).toMatchObject({ error: { code: EXECUTOR_ERRORS.unknownTurn } });

    // Exact boundary nowMs === expiresAtMs (51_000) -> lease expired, renew refused
    now += 30_000;
    const boundaryRenew = await post('/threads/renew', {
      threadId: 'th',
      instance: 'a',
      fence: 1,
    });
    expect(boundaryRenew.status).toBe(409);
    expect(boundaryRenew.body).toMatchObject({ error: { code: 'EXECUTOR_FENCE_STALE' } });

    // Re-claim -> fence 2, then release -> post-release renew refused
    const reclaimed = await post('/threads/claim', claim('a'));
    expect(reclaimed).toEqual({
      status: 200,
      body: { threadId: 'th', fence: 2, ttlMs: 30_000 },
    });
    const released = await post('/threads/release', {
      threadId: 'th',
      instance: 'a',
      fence: 2,
    });
    expect(released).toEqual({ status: 200, body: { released: true } });

    const postReleaseRenew = await post('/threads/renew', {
      threadId: 'th',
      instance: 'a',
      fence: 2,
    });
    expect(postReleaseRenew.status).toBe(409);
    expect(postReleaseRenew.body).toMatchObject({ error: { code: 'EXECUTOR_FENCE_STALE' } });

    const repeatRelease = await post('/threads/release', {
      threadId: 'th',
      instance: 'a',
      fence: 2,
    });
    expect(repeatRelease).toEqual({ status: 200, body: { released: false } });
  });
});
