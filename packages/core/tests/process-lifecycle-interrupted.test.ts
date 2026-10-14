import { expect, test } from 'bun:test';
import {
  transitionProcessDraining,
  transitionProcessReady,
  transitionProcessStart,
} from '../src/application/process-lifecycle-transitions';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14) + seconds * 1000).toISOString();
function predecessor(ready: boolean, draining: boolean) {
  let state = transitionProcessStart(null, {
    runId: 'old',
    pid: 10,
    version: '1',
    now: at(0),
  }).state;
  if (ready)
    state = transitionProcessReady(state, { runId: 'old', pid: 10, now: at(1) }).state;
  if (draining)
    state = transitionProcessDraining(state, { runId: 'old', pid: 10, now: at(3) }).state;
  return state;
}

test('an abandoned drain is interrupted, with a measured upper bound instead of an invented kill time', () => {
  const next = transitionProcessStart(predecessor(true, true), {
    runId: 'next',
    pid: 11,
    version: '2',
    now: at(7),
    versionChangeOverlap: 'abnormal',
  });
  expect(next.fact).toMatchObject({
    previousExit: 'interrupted',
    previousDrainUpperBoundMs: 4000,
    processGapMs: null,
  });
  expect(next.state.runs[1]).toMatchObject({
    termination: 'interrupted',
    stoppedAt: at(7),
    unavailableAt: at(3),
  });
});

test('a crash without draining remains abnormal and has no drain measurement', () => {
  const next = transitionProcessStart(predecessor(true, false), {
    runId: 'next',
    pid: 11,
    version: '1',
    now: at(7),
  });
  expect(next.fact).toMatchObject({
    previousExit: 'abnormal',
    previousDrainUpperBoundMs: null,
  });
  expect(next.state.runs[1]?.termination).toBe('abnormal');
});

test('a live handoff and same-pid hot reload do not turn an unfinished drain into a death', () => {
  const source = predecessor(true, true);
  const handoff = transitionProcessStart(source, {
    runId: 'next',
    pid: 11,
    version: '2',
    now: at(7),
  });
  expect(handoff.fact).toMatchObject({
    previousExit: 'handoff',
    previousDrainUpperBoundMs: null,
  });
  expect(handoff.state.runs[1]?.termination).toBe('draining');
  const hot = transitionProcessStart(source, {
    runId: 'next',
    pid: 10,
    version: '1',
    now: at(7),
  });
  expect(hot.fact.previousExit).toBe('hot-reload');
});

test('a drain before readiness is interrupted without inventing an admission-stop timestamp', () => {
  const next = transitionProcessStart(predecessor(false, true), {
    runId: 'next',
    pid: 11,
    version: '1',
    now: at(7),
  });
  expect(next.fact).toMatchObject({
    previousExit: 'interrupted',
    previousDrainUpperBoundMs: null,
  });
});

test('a successor clock behind admission stop cannot provide a drain upper bound', () => {
  const next = transitionProcessStart(predecessor(true, true), {
    runId: 'next',
    pid: 11,
    version: '1',
    now: at(2),
  });
  expect(next.fact).toMatchObject({
    previousExit: 'interrupted',
    previousDrainUpperBoundMs: null,
  });
});
