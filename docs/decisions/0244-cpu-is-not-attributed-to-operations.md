# 0244 — CPU is not attributed to operations

**Status:** Accepted
**Date:** 2026-10-05

Builds on ADR 0012 and ADR 0013. Invariants I6, I8 and I13.

## Context

A request completion record, a `runUnitOfWork` record and a `createManagedSchedule` status carry a
duration and counts, and no CPU. A consuming daemon that wanted to know where its idle CPU went
built its own profiler beside them: a `process.cpuUsage()` reading at the start and end of every
operation and every schedule pass, collected through a `Proxy` over its operations and a wrapper
around each schedule clock. Its rule credited the CPU of a window to "the single active operation".
A long waiting operation is almost always the single active one, so it absorbed the CPU of
unrelated work: a wait that ran no code of its own was reported with about 200 ms of CPU spent by a
timer.

The rule is wrong, not the arithmetic. One JavaScript thread interleaves every asynchronous
operation. Between an operation's start and end, the thread also runs other operations, timers,
socket reads and the framework's own work, and `process.cpuUsage()` is one counter for the whole
process. A CPU delta across an operation's wall-clock interval measures everything the process did in
that interval. The only correct basis is the synchronous segment: read the counter when a
continuation of the operation is entered and when it returns to the event loop, add the difference
to that operation, and put whatever ran outside every operation's segment into `unattributed`.

That basis needs the runtime to say when a continuation is entered and left. Measured on Bun 1.4.2:

- `node:async_hooks.createHook` exists and returns `enable`/`disable`, and delivers no callback:
  `init`, `before`, `after` and `promiseResolve` fire zero times across promises, `setImmediate`
  and `setTimeout`. The same probe on Node 24.18.0 delivers seven.
- `executionAsyncId()` is `0` in every continuation, so it cannot tell two segments apart.
- `AsyncLocalStorage` propagates a store across awaits, and runs nothing when a continuation is
  entered or left; it says which operation a segment belongs to only if something asks during the
  segment.
- A native `await` never calls `Promise.prototype.then`, so a library cannot bracket continuations
  by wrapping promises either.
- `bun:jsc` has a sampling profiler; it samples stacks, not the async context, so it can name a
  function and not an operation.

On Node the hook exists, and its own documentation advises against `createHook` for its cost and
safety. A feature that measures correctly only on the secondary adapter and is silently absent on the
first-class runtime breaks I6, and a feature that falls back to wall-clock windows on Bun reports a
number that was never observed, which breaks I13.

## Decision

stitchkit does not attribute CPU to requests, units of work or schedule passes. No record, status
or snapshot carries an operation's CPU, and there is no opt-in that would. stitchkit also adds no
process-CPU field of its own: the process total is `process.cpuUsage()`, and in OpenTelemetry it is
the standard `process.cpu.time` instrument of the host-metrics package; a stitchkit copy would be a
second owner of the same counter (I8). It is not put into `ApplicationSnapshot` either: a
counter that grows on every read would change the snapshot each time it is read, and `revision` and
`changedAt` would stop meaning that the application changed.

A consumer who builds attribution anyway follows one rule, and the guide states it
([observability → CPU is not attributed to work](../guide/observability.md#cpu-is-not-attributed-to-work)):

1. Attribute only synchronous segments: read the CPU counter when a segment of the operation begins
   running on the thread and when it yields, and credit that difference alone.
2. Time an operation spends waiting is never its CPU. Its wall-clock interval is not a measuring
   window.
3. CPU spent outside every attributed segment is `unattributed` and is reported as such, not spread
   over whatever is in flight.
4. Never credit a window to "the single active operation": the operation that is alone in flight is
   usually the one that is waiting.

Where the runtime gives no segment boundary, the honest output is process CPU per window plus the
durations and counts stitchkit already records; per-operation CPU is then unknown, not zero.

## Consequences

A daemon that needs per-operation CPU on Bun profiles out of process (a sampling profiler over a
reproduced load) or measures a synchronous function it calls directly, where the call's own
interval is a segment. Neither needs a framework hook.

The decision is re-opened when Bun delivers async context enter and leave callbacks. The runtime
facts above are pinned by `packages/core/tests/cpu-attribution-runtime.test.ts`; a red run there is
the signal, and the fix is a new ADR, not a changed expectation.

## Verification

`cpu-attribution-runtime.test.ts` asserts on Bun that `createHook` delivers no callback,
`executionAsyncId()` stays `0` across continuations, `AsyncLocalStorage` propagates without a
boundary callback, and a native `await` bypasses `Promise.prototype.then`. Run under Node, the hook
assertion is red, which is what the test is for.
