import { describe, expect, test } from 'bun:test';
import {
  createProcessLifecycleLedger,
  lifecycleLedgerResource,
} from '../src/application/process-lifecycle';
import {
  type LifecycleState,
  transitionProcessReady,
  transitionProcessShutdown,
  transitionProcessStart,
} from '../src/application/process-lifecycle-transitions';
import type { StateStore } from '../src/application/state-store';

function memoryStore<TState>(initial: TState | null = null): StateStore<TState> {
  let state = initial;
  let tail = Promise.resolve();
  return {
    async read() {
      await tail;
      return state;
    },
    update(transition) {
      const result = tail.then(async () => {
        const next = await transition(state);
        state = next.state;
        return next.result;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

const at = (second: number): string =>
  `2026-09-06T04:00:${String(second).padStart(2, '0')}.000Z`;

/** The run answered: without readiness a stop reads as a failed startup. */
function ready(state: LifecycleState, runId: string, pid: number, second: number) {
  return transitionProcessReady(state, { runId, pid, now: at(second) }).state;
}

describe('process lifecycle transitions', () => {
  test('classifies first boot, hot reload, clean, handoff, abnormal and unknown version', () => {
    const first = transitionProcessStart(null, {
      runId: 'a',
      pid: 10,
      version: '1',
      now: at(0),
    });
    expect(first.fact.previousExit).toBe('first-boot');

    const hot = transitionProcessStart(ready(first.state, 'a', 10, 0), {
      runId: 'b',
      pid: 10,
      version: '1',
      now: at(1),
    });
    expect(hot.fact.previousExit).toBe('hot-reload');
    expect(hot.state.runs.find((run) => run.runId === 'a')?.termination).toBe('hot-reload');

    const stopped = transitionProcessShutdown(ready(hot.state, 'b', 10, 1), {
      runId: 'b',
      pid: 10,
      now: at(2),
    });
    const clean = transitionProcessStart(stopped.state, {
      runId: 'c',
      pid: 11,
      version: '2',
      now: at(4),
    });
    expect(clean.fact).toMatchObject({
      previousExit: 'clean',
      processGapMs: 2_000,
      versionChanged: true,
    });

    const handoff = transitionProcessStart(clean.state, {
      runId: 'd',
      pid: 12,
      version: '3',
      now: at(5),
    });
    expect(handoff.fact.previousExit).toBe('handoff');
    const abnormal = transitionProcessStart(ready(handoff.state, 'd', 12, 5), {
      runId: 'e',
      pid: 13,
      version: '3',
      now: at(6),
    });
    expect(abnormal.fact.previousExit).toBe('abnormal');
    const unknown = transitionProcessStart(abnormal.state, {
      runId: 'f',
      pid: 14,
      version: 'unknown',
      now: at(7),
    });
    expect(unknown.fact.versionChanged).toBeFalse();
  });

  test('the predecessor is the newest by write order, even when its clock lags', () => {
    // Every write goes through one atomic update, so list order is causal;
    // `startedAt` comes from a clock that may step between two starts.
    const state: LifecycleState = {
      schemaVersion: 1,
      runs: [
        {
          runId: 'newer-by-order',
          pid: 2,
          version: '2',
          startedAt: at(3),
          readyAt: at(4),
          unavailableAt: null,
          stoppedAt: null,
          termination: 'active',
        },
        {
          runId: 'older-by-order',
          pid: 1,
          version: '1',
          startedAt: at(5),
          readyAt: null,
          unavailableAt: null,
          stoppedAt: at(6),
          termination: 'forced',
        },
      ],
    };
    const result = transitionProcessStart(state, {
      runId: 'current',
      pid: 3,
      version: '2',
      now: at(8),
    });
    expect(result.fact).toMatchObject({
      previousRunId: 'newer-by-order',
      previousExit: 'abnormal',
    });
    expect(result.state.runs.map((run) => run.runId)).toEqual([
      'current',
      'newer-by-order',
      'older-by-order',
    ]);
  });

  test('retention drops finished runs before a live handoff predecessor', () => {
    const first = transitionProcessStart(null, {
      runId: 'run-1',
      pid: 10,
      version: '1',
      now: at(0),
      retain: 2,
    });
    const second = transitionProcessStart(first.state, {
      runId: 'run-2',
      pid: 11,
      version: '2',
      now: at(1),
      retain: 2,
      sameVersionOverlap: 'handoff',
    });
    // The newest run stops while the older handoff predecessor is still live.
    const stopped = transitionProcessShutdown(second.state, {
      runId: 'run-2',
      pid: 11,
      now: at(2),
      retain: 2,
    });
    const third = transitionProcessStart(stopped.state, {
      runId: 'run-3',
      pid: 12,
      version: '3',
      now: at(3),
      retain: 2,
      sameVersionOverlap: 'handoff',
    });
    // Over the bound by one: the finished run-2 goes, not the live run-1 at the tail.
    expect(third.state.runs.map((run) => `${run.runId}:${run.termination}`)).toEqual([
      'run-3:active',
      'run-1:active',
    ]);
  });

  test('a hot-reloaded predecessor that finished reads as hot-reload, as recorded', () => {
    const recorded: LifecycleState = {
      schemaVersion: 1,
      runs: [
        {
          runId: 'reloaded',
          pid: 1,
          version: '1',
          startedAt: at(0),
          readyAt: null,
          unavailableAt: null,
          stoppedAt: at(1),
          termination: 'hot-reload',
        },
      ],
    };
    expect(
      transitionProcessStart(recorded, { runId: 'next', pid: 2, version: '1', now: at(2) })
        .fact.previousExit,
    ).toBe('hot-reload');
  });

  test('ready and shutdown are owned by run id plus pid and are idempotent', () => {
    const started = transitionProcessStart(null, {
      runId: 'owned',
      pid: 42,
      version: '1',
      now: at(0),
    });
    const wrong = transitionProcessShutdown(started.state, {
      runId: 'other',
      pid: 42,
      now: at(1),
    });
    expect(wrong.fact.recorded).toBeFalse();
    const ready = transitionProcessReady(wrong.state, {
      runId: 'owned',
      pid: 42,
      now: at(2),
    });
    expect(ready.fact).toMatchObject({ recorded: true, startupMs: 2_000 });
    const readyAgain = transitionProcessReady(ready.state, {
      runId: 'owned',
      pid: 42,
      now: at(3),
    });
    expect(readyAgain.fact).toMatchObject({ recorded: false, readyAt: at(2) });
    const stopped = transitionProcessShutdown(readyAgain.state, {
      runId: 'owned',
      pid: 42,
      now: at(4),
      forced: true,
    });
    expect(stopped.fact).toMatchObject({
      recorded: true,
      uptimeMs: 4_000,
      termination: 'forced',
    });
    expect(
      transitionProcessShutdown(stopped.state, {
        runId: 'owned',
        pid: 42,
        now: at(5),
      }).fact.recorded,
    ).toBeFalse();
  });

  test('ledger keeps one run identity and publishes only recorded facts', async () => {
    let now = new Date(at(0));
    const ledger = createProcessLifecycleLedger({
      store: memoryStore<LifecycleState>(),
      clock: () => now,
      pid: 88,
      runId: 'one-run',
    });
    const facts: string[] = [];
    ledger.subscribe((fact) => {
      facts.push(fact.type);
    });
    await ledger.recordStart({ version: '1' });
    now = new Date(at(1));
    await ledger.recordReady();
    await ledger.recordReady();
    now = new Date(at(2));
    await ledger.recordShutdown();
    await ledger.recordShutdown();
    await Promise.resolve();
    expect(facts).toEqual(['started', 'ready', 'stopped']);
    expect(await ledger.current()).toMatchObject({ runId: 'one-run', termination: 'clean' });
  });

  test('a restarted ledger resource gets a fresh run id even when the pid is reused', async () => {
    let sequence = 0;
    let now = new Date(at(0));
    const ledger = createProcessLifecycleLedger({
      store: memoryStore<LifecycleState>(),
      clock: () => now,
      pid: 88,
      runId: () => `run-${++sequence}`,
    });
    expect((await ledger.recordStart({ version: '1' })).runId).toBe('run-1');
    now = new Date(at(1));
    await ledger.recordReady();
    await ledger.recordShutdown();
    now = new Date(at(2));
    const restarted = await ledger.recordStart({ version: '1' });
    expect(restarted).toMatchObject({ runId: 'run-2', previousExit: 'clean' });
    expect(await ledger.current()).toMatchObject({ runId: 'run-2', pid: 88 });
  });

  test('a failed durable shutdown remains retryable', async () => {
    const base = memoryStore<LifecycleState>();
    let rejectNext = false;
    const store: StateStore<LifecycleState> = {
      read: () => base.read(),
      update(transition) {
        if (rejectNext) {
          rejectNext = false;
          return Promise.reject(new Error('disk unavailable'));
        }
        return base.update(transition);
      },
    };
    const ledger = createProcessLifecycleLedger({
      store,
      pid: 88,
      runId: 'retryable-stop',
      clock: () => new Date(at(0)),
    });
    const resource = lifecycleLedgerResource(ledger, { version: '1' });
    await resource.start();
    await resource.activate?.({} as never);
    rejectNext = true;
    await expect(resource.close?.({} as never)).rejects.toThrow('disk unavailable');
    await expect(resource.close?.({} as never)).resolves.toBeUndefined();
    expect(await ledger.current()).toMatchObject({ termination: 'clean' });
  });
  test('an unknown version never turns a crash into a handoff', () => {
    const first = transitionProcessStart(null, {
      runId: 'released',
      pid: 10,
      version: '1.0.0',
      now: at(0),
    });
    // A dev build that cannot name its version starts while the released run
    // is still marked active under another pid: nothing says a new build
    // arrived, so the predecessor did not hand over — it stopped answering.
    const unknown = transitionProcessStart(ready(first.state, 'released', 10, 0), {
      runId: 'dev',
      pid: 11,
      version: 'unknown',
      now: at(1),
    });
    expect(unknown.fact).toMatchObject({
      previousExit: 'abnormal',
      versionChanged: false,
      previousRunId: 'released',
    });
    expect(unknown.state.runs.find((run) => run.runId === 'released')).toMatchObject({
      termination: 'abnormal',
      stoppedAt: at(1),
    });
    // And the other direction: a released build after an unknown one.
    const released = transitionProcessStart(ready(unknown.state, 'dev', 11, 1), {
      runId: 'released-again',
      pid: 12,
      version: '1.0.0',
      now: at(2),
    });
    expect(released.fact).toMatchObject({ previousExit: 'abnormal', versionChanged: false });
  });

  test('a crash observed by the successor stays distinct from a forced stop', () => {
    const crashed: LifecycleState = {
      schemaVersion: 1,
      runs: [
        {
          runId: 'crashed',
          pid: 1,
          version: '1',
          startedAt: at(0),
          readyAt: at(1),
          unavailableAt: null,
          stoppedAt: at(5),
          termination: 'abnormal',
        },
      ],
    };
    const next = transitionProcessStart(crashed, {
      runId: 'after-crash',
      pid: 2,
      version: '1',
      now: at(9),
    });
    expect(next.fact).toMatchObject({ previousExit: 'abnormal', processGapMs: 4_000 });
    // Nobody timed the crash, so how long nobody answered is unknown.
    expect(
      transitionProcessReady(next.state, { runId: 'after-crash', pid: 2, now: at(10) }).fact
        .downtimeMs,
    ).toBeNull();
  });

  test('same-version overlap is a crash by default and a handoff by declaration', () => {
    const first = transitionProcessStart(null, {
      runId: 'worker-1',
      pid: 10,
      version: '2.0.0',
      now: at(0),
    });
    const serving = ready(first.state, 'worker-1', 10, 0);
    const crash = transitionProcessStart(serving, {
      runId: 'worker-2',
      pid: 11,
      version: '2.0.0',
      now: at(1),
    });
    expect(crash.fact.previousExit).toBe('abnormal');

    const overlap = transitionProcessStart(serving, {
      runId: 'worker-2',
      pid: 11,
      version: '2.0.0',
      now: at(1),
      sameVersionOverlap: 'handoff',
    });
    expect(overlap.fact).toMatchObject({ previousExit: 'handoff', versionChanged: false });
    // The predecessor is still running and records its own exit later.
    expect(overlap.state.runs.find((run) => run.runId === 'worker-1')?.termination).toBe(
      'active',
    );
    const stopped = transitionProcessShutdown(overlap.state, {
      runId: 'worker-1',
      pid: 10,
      now: at(2),
    });
    expect(stopped.fact).toMatchObject({ recorded: true, termination: 'clean' });
  });

  test('a version change is a handoff by default and a crash when builds never overlap', () => {
    const first = transitionProcessStart(null, {
      runId: 'release-1',
      pid: 10,
      version: '1.0.0',
      now: at(0),
    });
    const serving = ready(first.state, 'release-1', 10, 0);
    const handoff = transitionProcessStart(serving, {
      runId: 'release-2',
      pid: 11,
      version: '1.1.0',
      now: at(5),
    });
    expect(handoff.fact.previousExit).toBe('handoff');

    const crashed = transitionProcessStart(serving, {
      runId: 'release-2',
      pid: 11,
      version: '1.1.0',
      now: at(5),
      versionChangeOverlap: 'abnormal',
    });
    expect(crashed.fact).toMatchObject({
      previousExit: 'abnormal',
      previousVersion: '1.0.0',
      versionChanged: true,
      processGapMs: null,
    });
    expect(crashed.state.runs.find((run) => run.runId === 'release-1')).toMatchObject({
      termination: 'abnormal',
      stoppedAt: at(5),
      unavailableAt: null,
    });
    // Nobody timed the crash, so the downtime is unknown — never zero.
    const readyAfterCrash = transitionProcessReady(crashed.state, {
      runId: 'release-2',
      pid: 11,
      now: at(9),
    });
    expect(readyAfterCrash.fact).toMatchObject({ downtimeMs: null, unavailableSince: null });

    const neverReady = transitionProcessStart(first.state, {
      runId: 'release-2',
      pid: 11,
      version: '1.1.0',
      now: at(5),
      versionChangeOverlap: 'abnormal',
    });
    expect(neverReady.fact.previousExit).toBe('startup-failed');
    expect(neverReady.state.runs.find((run) => run.runId === 'release-1')?.termination).toBe(
      'startup-failed',
    );
  });

  test('a clean stop before a version change still measures downtime when builds never overlap', () => {
    const first = transitionProcessStart(null, {
      runId: 'release-1',
      pid: 10,
      version: '1.0.0',
      now: at(0),
    });
    const stopped = transitionProcessShutdown(ready(first.state, 'release-1', 10, 1), {
      runId: 'release-1',
      pid: 10,
      now: at(10),
    }).state;
    const next = transitionProcessStart(stopped, {
      runId: 'release-2',
      pid: 11,
      version: '1.1.0',
      now: at(12),
      versionChangeOverlap: 'abnormal',
    });
    expect(next.fact).toMatchObject({ previousExit: 'clean', versionChanged: true });
    const readyFact = transitionProcessReady(next.state, {
      runId: 'release-2',
      pid: 11,
      now: at(15),
    }).fact;
    expect(readyFact).toMatchObject({ downtimeMs: 5_000, unavailableSince: at(10) });
  });

  test('declared same-build overlap does not keep a different build open when builds never overlap', () => {
    const first = transitionProcessStart(null, {
      runId: 'a',
      pid: 10,
      version: '1',
      now: at(0),
    });
    const second = transitionProcessStart(ready(first.state, 'a', 10, 0), {
      runId: 'b',
      pid: 11,
      version: '1',
      now: at(1),
      sameVersionOverlap: 'handoff',
    });
    const third = transitionProcessStart(ready(second.state, 'b', 11, 1), {
      runId: 'c',
      pid: 12,
      version: '2',
      now: at(2),
      sameVersionOverlap: 'handoff',
      versionChangeOverlap: 'abnormal',
    });
    expect(third.fact).toMatchObject({ previousExit: 'abnormal', versionChanged: true });
    expect(third.state.runs.map((run) => [run.runId, run.termination])).toEqual([
      ['c', 'active'],
      ['b', 'abnormal'],
      ['a', 'abnormal'],
    ]);
  });

  test('the ledger carries the overlap policy into every start', async () => {
    const store = memoryStore<LifecycleState>();
    const older = createProcessLifecycleLedger({
      store,
      pid: 20,
      runId: 'older',
      clock: () => new Date(at(0)),
      sameVersionOverlap: 'handoff',
    });
    const newer = createProcessLifecycleLedger({
      store,
      pid: 21,
      runId: 'newer',
      clock: () => new Date(at(1)),
      sameVersionOverlap: 'handoff',
    });
    await older.recordStart({ version: '3' });
    expect((await newer.recordStart({ version: '3' })).previousExit).toBe('handoff');
    expect((await older.recordShutdown()).recorded).toBeTrue();
  });

  test('the ledger carries the version-change policy into every start', async () => {
    const store = memoryStore<LifecycleState>();
    const older = createProcessLifecycleLedger({
      store,
      versionChangeOverlap: 'abnormal',
      pid: 20,
      runId: 'older',
      clock: () => new Date(at(0)),
    });
    const newer = createProcessLifecycleLedger({
      store,
      versionChangeOverlap: 'abnormal',
      pid: 21,
      runId: 'newer',
      clock: () => new Date(at(3)),
    });
    await older.recordStart({ version: '3' });
    await older.recordReady();
    expect(await newer.recordStart({ version: '4' })).toMatchObject({
      previousExit: 'abnormal',
      versionChanged: true,
    });
    expect((await newer.recordReady()).downtimeMs).toBeNull();
    expect((await older.recordShutdown()).recorded).toBeFalse();
  });
  test("a restarted ledger resource records the second run's shutdown too", async () => {
    let sequence = 0;
    const facts: string[] = [];
    const ledger = createProcessLifecycleLedger({
      store: memoryStore<LifecycleState>(),
      pid: 88,
      runId: () => `run-${++sequence}`,
      clock: () => new Date(at(sequence)),
    });
    ledger.subscribe((fact) => {
      facts.push(`${fact.type}:${fact.runId}`);
    });
    const resource = lifecycleLedgerResource(ledger, { version: '1' });
    for (let round = 0; round < 2; round += 1) {
      await resource.start();
      await resource.activate?.({} as never);
      await resource.close?.({} as never);
    }
    await Promise.resolve();
    expect(facts).toEqual([
      'started:run-1',
      'ready:run-1',
      'stopped:run-1',
      'started:run-2',
      'ready:run-2',
      'stopped:run-2',
    ]);
    expect((await ledger.runs()).map((run) => run.termination)).toEqual(['clean', 'clean']);
  });
});
