---
title: Bound managed server shutdown with active cooperative HTTP streams
description: Cancel owned long-lived HTTP response sources before stopping the runtime and report completed cleanup truthfully.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 06:09 +00:00
priority: P1
---

## Evidence

Published `stitchkit@0.70.2` and `0.70.4`, Bun 1.3.14, macOS arm64: a real
`defineContract` NDJSON endpoint implemented by a cooperative async generator returns a
positive HTTP 200 frame. The generator then waits for its supplied `signal`. Calling
`createApplication().shutdown()` with `managedServerResource` and 100 ms grace / 200 ms
force budgets returns after about 301 ms with `cleanupComplete: false`, resource
`force-failed`, server `pendingRequests: 1`. The source signal is not aborted and its
finally block has not run. The same generator returning after its first frame is a
positive baseline: `clean`, cleanup complete, pending zero, about 3 ms.

A real Linux Bun 1.3.14 service using this managed boundary reproduces the same failure
at normal 5000/2000 ms budgets: control resource `force-failed` after about 7003 ms,
including when application-admission pending/completed counts are both zero. This is
not evidence of a lost durable operation; it is a response-stream cleanup gap.

An additional raw Bun Unix-socket probe separates the runtime behavior: completed JSON
keepalive requests allow `stop(true)` to settle immediately; with an open response stream,
`stop(false)` followed by `stop(true)` remains pending beyond 1500 ms on macOS and Linux.
The framework must not depend on that call alone to cancel its cooperative stream sources.

Source inspection: `server/shutdown.ts` tracks handler promise settlement, not the full
stream body lifetime; the Bun adapter delegates forced stop to `runtime.stop(true)`;
`application/server-resource.ts` awaits the same shutdown promise. Inspect the current
server/contract-stream ownership before choosing the fix. Do not add a consumer socket
wrapper, second lifecycle, unconditional process exit or suppress the cleanup error.

## Reproduction

Use the published package with this contract and a real Unix socket. Keep the response
reader open after its first nonempty frame. The source cooperates with cancellation:

```ts
const contract = defineContract({ prefix: 'probe', scope: 'local' }, {
  events: {
    method: 'GET', path: '/', desc: 'Read a resident signal-aware stream',
    stream: { item: z.object({ ready: z.boolean() }), format: 'ndjson', heartbeatMs: 100 },
  },
});
let aborted = false;
let returned = false;
const service = implement(contract, {
  events: async function* ({ signal }) {
    try {
      yield { ready: true };
      await new Promise<void>((resolve) => {
        if (signal.aborted) { aborted = true; resolve(); return; }
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
    } finally { returned = true; }
  },
});
const server = await createServer({ unix: { path, mode: 0o600 }, services: [service], logging: false });
const app = createApplication({
  id: 'probe', resources: [managedServerResource({ id: 'http', server })],
  shutdown: { gracePeriodMs: 100, forceTimeoutMs: 200 },
});
await app.start();
const response = await fetch('http://localhost/probe/', { unix: path });
const reader = response.body!.getReader();
await reader.read(); // Assert HTTP 200 and a nonempty frame first.
const result = await app.shutdown();
// Currently: !result.cleanupComplete, !aborted, !returned, pendingRequests === 1.
```

Use an outer bounded watchdog in the probe, not in application implementation. No provider,
credential, external network endpoint or product fixture is needed. The finite-generator
positive control must pass before interpreting the open-stream result.

## Requested result

The managed request owns both handler execution and registered streaming source cleanup.
Shutdown closes admission, cancels owned subscriptions, waits for their iterator cleanup within
the existing grace/force budgets, then stops the transport. Plain finite HTTP work still drains.
Runtime connection closure is not proof that an uncooperative source finished.

- [x] Reproduce through the current published package and identify the exact ownership gap.
- [x] Make managed shutdown cancel cooperative owned HTTP stream sources and settle response
      resources before declaring cleanup complete. Preserve admission refusal and bounded force.
- [x] Cover live NDJSON and SSE, finite streams, client disconnect, idle keepalive, concurrent
      streams and non-cooperative producers. Preserve truthful pending/aborted counts and errors.
- [x] Prove Bun Unix/TCP and supported Node semantics through real servers, not only fake handles;
      keep the existing WebSocket/Socket.IO shutdown and application resource ordering green.
- [x] Update public lifecycle documentation, package consumer tests and release evidence.
      Exact version/SHA/artifact publication acceptance belongs to the enclosing core 0.70.5
      release train selected in `release-train.json`; it is not inferred from implementation
      completion. Consumers need no additional managed-stream lifetime wiring.

## Boundaries

No consumer repository, process supervisor, provider writer, host configuration, credentials or
historical data changes. A finite cooperative stream is expected to clean up; an uncooperative
source must stay bounded and honestly reported, not silently presented as clean.

## Что сделано

- [x] `packages/core/src/server/http-stream-lifetime.ts` binds native request identity to
  registered source cleanup. `server/shutdown.ts` cancels streams at admission close and retains
  outstanding cleanup in its existing grace/force lifecycle. No consumer shutdown engine is needed.
- [x] `server/streaming-route.ts` observes both the reading pump and iterator return, preserving
  cleanup errors and expected cancellation. `server/contract-stream.ts` separates bounded wire
  completion from the owned producer cleanup, including cancellation before the first frame.
- [x] `packages/core/tests/server-stream-shutdown.test.ts`:
  `managed ndjson streams finish their source before dependencies close`, its SSE counterpart,
  `raw stream cancellation retains a waiting finally in managed pending counts`,
  `client disconnect settles the source before later managed shutdown`,
  `non-cooperative contract source remains pending after bounded force failure`,
  `source cleanup error is not reported as a clean managed shutdown`,
  `a cooperative source rejecting with its abort reason still closes cleanly`,
  `shutdown cancels an admitted async stream factory before its response exists`, and
  `contract lifetime bounds the wire even when source cleanup ignores cancellation` pass.
- [x] `packages/core/scripts/consumer-lane/fixtures/node/src/stream-shutdown.mjs` runs finite
  controls before open streams on Bun TCP/Unix and Node TCP, NDJSON/SSE; the packed lane executes
  it under both runtimes. Published 0.70.4 fails the open TCP probe after the finite control passes.
- [x] Focused shutdown/contract/application checks: 88 tests, 0 failures, 309 assertions;
  workspace typechecks pass. Existing WebSocket/Socket.IO shutdown tests remain green.
  Direct built-package stream probes pass under Bun and Node. The final packed-consumer run
  passes with explicit `node: stream shutdown (bun)` and `node: stream shutdown (node)` steps.
- [x] `docs/guide/server.md`, `docs/guide/application-kernel.md` and `docs/api/reference.md`
  describe ownership, cancellation, pending counts and the standalone/raw-body boundary.
  `CHANGELOG.md` and `release-train.json` select core 0.70.5 only.

Publication is the enclosing release train, not a claim made by this local implementation record.
The exact release SHA and artifact integrity are established by CI/registry acceptance and the
release receipt. No consumer rollout, new cancellation wiring or global configuration change is
part of this task.

## Release acceptance

The first local release gate stopped in the starter lane when its PostgreSQL prerequisite
failed with filesystem exhaustion. Database readiness and disk headroom were restored before
resuming validation. The packed-consumer lane independently passed with the final stream fixture
registration. Implementation acceptance is complete; the enclosing release train still requires
its final exact-tree gate, exact-SHA CI and registry artifact verification before publication is
reported complete. The tag and immutable artifact receipt provide that publication evidence.
