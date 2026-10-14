import assert from 'node:assert/strict';
import {
  transitionProcessDraining,
  transitionProcessReady,
  transitionProcessStart,
} from 'stitchkit/application';

const at = (seconds) => new Date(Date.UTC(2026, 9, 14) + seconds * 1000).toISOString();
const start = transitionProcessStart(null, {
  runId: 'old',
  pid: 10,
  version: '1',
  now: at(0),
});
const ready = transitionProcessReady(start.state, { runId: 'old', pid: 10, now: at(1) });
const draining = transitionProcessDraining(ready.state, { runId: 'old', pid: 10, now: at(3) });
const input = { runId: 'next', pid: 11, version: '1', now: at(7) };
const interrupted = transitionProcessStart(draining.state, input);
assert.equal(interrupted.fact.previousExit, 'interrupted');
assert.equal(interrupted.fact.previousDrainUpperBoundMs, 4000);
assert.equal(interrupted.state.runs[1].termination, 'interrupted');
const crash = transitionProcessStart(ready.state, input);
assert.equal(crash.fact.previousExit, 'abnormal');
assert.equal(crash.fact.previousDrainUpperBoundMs, null);
console.log('packed interrupted process lifecycle: ok');
