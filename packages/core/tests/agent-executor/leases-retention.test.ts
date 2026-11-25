/**
 * Turn receipts are kept for each thread's most recent turns only: the lease state is bounded by
 * the threads, never by the turns they ran. A turn carries the ordinal the server offered it under,
 * so a report of a turn let go — its first report included — is answered for what it is, not
 * retained, rather than applied again; and a hello learns the same of a turn it resumes.
 */
import { describe, expect, test } from 'bun:test';
import {
  createExecutorLeases,
  EXECUTOR_ERRORS,
  memoryExecutorLeaseStore,
} from '../../src/entrypoints/agent-executor';

type Phase = 'dispatching' | 'delivered' | 'completed' | 'failed';

async function claimed(retainedTurns?: number) {
  const store = memoryExecutorLeaseStore();
  const service = createExecutorLeases({
    store,
    now: () => 1_000,
    ttlMs: 30_000,
    ...(retainedTurns !== undefined && { retainedTurns }),
  });
  const claim = (threadId: string) =>
    service.claim({ threadId, executorId: 'mac', instance: 'a', profileId: 'p' });
  const fences = new Map([['th', (await claim('th')).fence]]);
  const report = (
    turnId: string,
    turnOrdinal: number,
    executorSeq: number,
    phase: Phase,
    threadId = 'th',
  ) =>
    service.report({
      turnId,
      threadId,
      turnOrdinal,
      instance: 'a',
      fence: fences.get(threadId) ?? 0,
      executorSeq,
      phase,
      deltas: [],
    });
  /** One turn, start to end, as an executor reports it. */
  const run = async (turnId: string, turnOrdinal: number) => {
    await report(turnId, turnOrdinal, 1, 'dispatching');
    await report(turnId, turnOrdinal, 2, 'delivered');
    return report(turnId, turnOrdinal, 3, 'completed');
  };
  const claimAnother = async (threadId: string) => {
    fences.set(threadId, (await claim(threadId)).fence);
  };
  return { service, store, report, run, claimAnother };
}

/** Turn ids of one width, so the state's size changes only with how many are kept. */
const id = (n: number) => `turn-${String(n).padStart(6, '0')}`;

describe('turn receipts are kept for the last retainedTurns turns of a thread', () => {
  test('the state stays the same size however many turns the thread ran', async () => {
    const { store, run } = await claimed(4);
    for (let n = 0; n < 200; n++) await run(id(n), 1_000 + n);
    const after200 = store.snapshot();
    for (let n = 200; n < 500; n++) await run(id(n), 1_000 + n);
    const after500 = store.snapshot();
    expect(Object.keys(after500.turns)).toEqual([id(496), id(497), id(498), id(499)]);
    expect(after500.threads.th).toMatchObject({
      recentTurns: [id(496), id(497), id(498), id(499)],
      forgottenThrough: 1_495,
    });
    // Ordinals 1 195 and 1 495 let go: the same width, so the same size.
    expect(JSON.stringify(after500).length).toBe(JSON.stringify(after200).length);
  });

  test('a resent report of a kept turn is a duplicate, of a turn let go not-retained — its first report too — and none changes the state', async () => {
    const { store, report, run } = await claimed(2);
    for (let n = 0; n < 5; n++) await run(id(n), n + 1);
    const before = store.snapshot();
    expect(await report(id(4), 5, 3, 'completed')).toEqual({
      outcome: 'duplicate',
      ackedSeq: 3,
    });
    expect(await report(id(0), 1, 3, 'completed')).toEqual({ outcome: 'not-retained' });
    expect(await report(id(0), 1, 1, 'dispatching')).toEqual({ outcome: 'not-retained' });
    expect(store.snapshot()).toEqual(before);
  });

  test('a resent first report of a turn let go keeps the live receipts, and a kept turn stays on its thread', async () => {
    // As the round's probe plays it: three turns through two kept receipts.
    const { store, report, run, claimAnother } = await claimed(2);
    for (const [n, turnId] of ['t0', 't1', 't2'].entries()) await run(turnId, n + 1);
    expect(await report('t0', 1, 1, 'dispatching')).toEqual({ outcome: 'not-retained' });
    expect(store.snapshot().threads.th).toMatchObject({
      recentTurns: ['t1', 't2'],
      forgottenThrough: 1,
    });
    await claimAnother('th2');
    await expect(report('t1', 1, 1, 'dispatching', 'th2')).rejects.toMatchObject({
      code: EXECUTOR_ERRORS.unknownTurn,
    });
  });

  test('a new turn still starts on a thread that let turns go, its first report a refusal too', async () => {
    const { report, run } = await claimed(2);
    for (let n = 0; n < 3; n++) await run(id(n), n + 1);
    expect(await report('fresh', 4, 1, 'dispatching')).toEqual({
      outcome: 'applied',
      ackedSeq: 1,
    });
    expect(await report('refused', 5, 1, 'failed')).toEqual({
      outcome: 'applied',
      ackedSeq: 1,
    });
  });

  test('the turn offered first goes, whichever was reported first, so every kept turn stays above the mark', async () => {
    const { store, report, run } = await claimed(2);
    // The second turn's first report arrives before the first turn's.
    await report('second', 2, 1, 'dispatching');
    await report('first', 1, 1, 'dispatching');
    await run('third', 3);
    expect(store.snapshot().threads.th).toMatchObject({
      recentTurns: ['second', 'third'],
      forgottenThrough: 1,
    });
    expect(await report('second', 2, 2, 'delivered')).toEqual({
      outcome: 'applied',
      ackedSeq: 2,
    });
  });

  test('a kept turn reported under another ordinal is refused', async () => {
    const { report, run } = await claimed(2);
    await run('t', 7);
    await expect(report('t', 8, 4, 'completed')).rejects.toMatchObject({
      code: EXECUTOR_ERRORS.unknownTurn,
    });
  });

  test('a thread that let no turn go still refuses a turn that skipped its start', async () => {
    const { report } = await claimed(2);
    await expect(report('never-seen', 1, 3, 'completed')).rejects.toMatchObject({
      code: EXECUTOR_ERRORS.invalidPhase,
    });
  });

  test('the default keeps 64 turns', async () => {
    const { store, run } = await claimed();
    for (let n = 0; n < 70; n++) await run(id(n), n + 1);
    expect(store.snapshot().threads.th).toMatchObject({ forgottenThrough: 6 });
    expect(Object.keys(store.snapshot().turns)).toHaveLength(64);
  });

  test('retainedTurns that is not a positive integer up to 1024 is refused', () => {
    const make = (retainedTurns: number) =>
      createExecutorLeases({
        store: memoryExecutorLeaseStore(),
        now: () => 0,
        ttlMs: 30_000,
        retainedTurns,
      });
    for (const bad of [0, -1, 1.5, Number.NaN, 1025]) {
      expect(() => make(bad), String(bad)).toThrow(RangeError);
    }
    expect(() => make(1024)).not.toThrow();
  });
});

describe('a hello resuming turns learns what the server holds of each', () => {
  test('a kept turn up to its receipt, a turn let go as not-retained, a turn never seen from zero', async () => {
    const { service, report, run } = await claimed(2);
    for (let n = 0; n < 3; n++) await run(id(n), n + 1);
    await report('half', 4, 1, 'dispatching');
    const resumable = (turnId: string, turnOrdinal: number) => ({
      turnId,
      threadId: 'th',
      turnOrdinal,
      fence: 1,
      executorSeq: 3,
    });
    expect(
      await service.resume([resumable('half', 4), resumable(id(0), 1), resumable('never', 9)]),
    ).toEqual([
      { outcome: 'acked', turnId: 'half', ackedSeq: 1 },
      { outcome: 'not-retained', turnId: id(0) },
      { outcome: 'acked', turnId: 'never', ackedSeq: 0 },
    ]);
  });
});
