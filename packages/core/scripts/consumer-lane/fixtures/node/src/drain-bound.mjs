import assert from 'node:assert/strict';
import { createObservability, createTraceContext } from 'stitchkit/observability';

/**
 * A drain bound has to fire when it is the ONLY thing left to fire.
 *
 * Every in-process test of this passes against a bound that can never fire: a
 * test runner keeps the event loop alive on its own. In a real process a
 * pending write holds nothing, so the stuck write and the bound's timer are the
 * only work there is — and an unref'd timer lets the loop empty, leaving
 * `close()` unsettled forever. Node exits 13 on an unsettled top-level await,
 * so this file simply has to run to completion to prove the opposite.
 *
 * That shipped once, in the release that added the bound, and nothing but a
 * real install under a real runtime could have caught it.
 */
const observability = createObservability({
  request: { write: () => new Promise(() => undefined) },
});
observability.request?.complete({
  context: {
    trace: createTraceContext(),
    source: 'http',
    method: 'GET',
    path: '/stuck',
    startedAt: process.hrtime.bigint(),
  },
  statusCode: 200,
  durationMs: 1,
});
await new Promise((resolve) => setTimeout(resolve, 20));

const startedAt = Date.now();
const report = await observability.close({ timeoutMs: 150 });
const waited = Date.now() - startedAt;

assert.equal(report.drained, false, 'a stuck write must not report a complete drain');
assert.equal(report.total.pending, 1, 'the report must name the unwritten event');
assert.ok(waited < 5_000, `close waited ${waited}ms, which is not a bound`);

console.log('packed drain bound: ok');
