import { describe, expect, test } from 'bun:test';
import {
  createProcessLifecycleLedger,
  lifecycleLedgerResource,
} from '../src/application/process-lifecycle';
import {
  type LifecycleState,
  LifecycleStateSchema,
  transitionProcessReady,
  transitionProcessShutdown,
  transitionProcessStart,
} from '../src/application/process-lifecycle-transitions';
import type { StateStore } from '../src/application/state-store';

/*
 * Downtime is the window in which nobody answers: from the moment the old run
 * stopped admitting work to the moment the new one is ready. Measured between
 * two processes instead, a 110 s forced drain read as the same four seconds
 * before and after it was fixed — the defect was invisible on the card a
 * consuming project accepts every release by.
 */

function memoryStore(initial: LifecycleState | null = null): StateStore<LifecycleState> {
  let state = initial;
  return {
    async read() {
      return state;
    },
    async update(transition) {
      const next = await transition(state);
      state = next.state;
      return next.result;
    },
  };
}

const base = Date.parse('2026-09-23T09:00:00.000Z');
const at = (seconds: number): string => new Date(base + seconds * 1_000).toISOString();
const context = {} as never;

describe('the lifecycle ledger measures unavailability', () => {
  test('a 110 s drain and a 4 s boot are 114 s of downtime, not 4', async () => {
    const store = memoryStore();
    let now = 0;
    const clock = () => new Date(at(now));
    const old = lifecycleLedgerResource(
      createProcessLifecycleLedger({ store, clock, pid: 1, runId: 'old' }),
      { version: '1' },
    );
    await old.start();
    await old.activate?.(context);
    now = 100;
    await old.stopAdmission?.(context);
    now = 210;
    await old.force?.(context);

    const ledger = createProcessLifecycleLedger({ store, clock, pid: 2, runId: 'new' });
    const facts: unknown[] = [];
    ledger.subscribe((fact) => {
      facts.push(fact);
    });
    const next = lifecycleLedgerResource(ledger, { version: '2' });
    now = 210;
    await next.start();
    now = 214;
    await next.activate?.(context);
    await Promise.resolve();

    expect(facts).toMatchObject([
      { type: 'started', previousExit: 'forced', processGapMs: 0 },
      { type: 'ready', startupMs: 4_000, downtimeMs: 114_000, unavailableSince: at(100) },
    ]);
    expect((await ledger.runs()).find((run) => run.runId === 'old')).toMatchObject({
      unavailableAt: at(100),
      stoppedAt: at(210),
      termination: 'forced',
    });
  });

  test('a run that ends before it is ready is startup-failed, by itself or by its successor', async () => {
    const store = memoryStore();
    const ledger = createProcessLifecycleLedger({
      store,
      clock: () => new Date(at(0)),
      pid: 1,
      runId: 'rolled-back',
    });
    const resource = lifecycleLedgerResource(ledger, { version: '1' });
    await resource.start();
    // A failed startup rolls back with `close` and never reaches `activate`.
    await resource.close?.(context);
    expect(await ledger.current()).toMatchObject({ termination: 'startup-failed' });

    const crashedInBoot = transitionProcessStart(null, {
      runId: 'crashed-in-boot',
      pid: 5,
      version: '1',
      now: at(0),
    });
    const successor = transitionProcessStart(crashedInBoot.state, {
      runId: 'successor',
      pid: 6,
      version: '1',
      now: at(3),
    });
    expect(successor.fact.previousExit).toBe('startup-failed');
    expect(successor.state.runs[1]).toMatchObject({ termination: 'startup-failed' });
  });

  test('every abandoned open run is closed at the next start, not only the newest', () => {
    const state: LifecycleState = {
      schemaVersion: 1,
      runs: [1, 2].map((pid) => ({
        runId: `crashed-${pid}`,
        pid,
        version: '1',
        startedAt: at(pid),
        readyAt: at(pid),
        unavailableAt: null,
        stoppedAt: null,
        termination: 'active' as const,
      })),
    };
    const next = transitionProcessStart(state, {
      runId: 'next',
      pid: 3,
      version: '1',
      now: at(10),
    });
    expect(next.state.runs.map((run) => `${run.runId}:${run.termination}`)).toEqual([
      'next:active',
      'crashed-1:abnormal',
      'crashed-2:abnormal',
    ]);
  });

  test('downtime opens at the last run that served, past a failed start', () => {
    let state = transitionProcessStart(null, {
      runId: 'a',
      pid: 1,
      version: '1',
      now: at(0),
    }).state;
    state = transitionProcessReady(state, { runId: 'a', pid: 1, now: at(1) }).state;
    state = transitionProcessShutdown(state, { runId: 'a', pid: 1, now: at(10) }).state;
    state = transitionProcessStart(state, {
      runId: 'b',
      pid: 2,
      version: '2',
      now: at(11),
    }).state;
    state = transitionProcessShutdown(state, { runId: 'b', pid: 2, now: at(12) }).state;
    state = transitionProcessStart(state, {
      runId: 'c',
      pid: 3,
      version: '1',
      now: at(20),
    }).state;
    const readyC = transitionProcessReady(state, { runId: 'c', pid: 3, now: at(25) });
    expect(readyC.fact).toMatchObject({ downtimeMs: 15_000, unavailableSince: at(10) });
  });

  test('a handoff predecessor still answering leaves no downtime', () => {
    let state = transitionProcessStart(null, {
      runId: 'a',
      pid: 1,
      version: '1',
      now: at(0),
    }).state;
    state = transitionProcessReady(state, { runId: 'a', pid: 1, now: at(1) }).state;
    state = transitionProcessStart(state, {
      runId: 'b',
      pid: 2,
      version: '2',
      now: at(5),
    }).state;
    const readyB = transitionProcessReady(state, { runId: 'b', pid: 2, now: at(8) });
    expect(readyB.fact).toMatchObject({ downtimeMs: 0, unavailableSince: null });
  });

  test('a ledger written before unavailableAt existed still loads', () => {
    const written = {
      schemaVersion: 1,
      runs: [
        {
          runId: 'old-format',
          pid: 1,
          version: '1',
          startedAt: at(0),
          readyAt: at(1),
          stoppedAt: at(9),
          termination: 'clean',
        },
      ],
    };
    const loaded = LifecycleStateSchema.parse(written);
    expect(loaded.runs[0]?.unavailableAt).toBeNull();
    expect(
      transitionProcessStart(loaded, { runId: 'next', pid: 2, version: '1', now: at(10) })
        .fact,
    ).toMatchObject({ previousExit: 'clean', processGapMs: 1_000 });
  });
});
