---
title: Unix streaming bodies need bounded buffering without a cumulative response cap
description: Compose long-lived NDJSON subscriptions with the Unix adapter without treating their lifetime byte count as retained memory.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 07:39 +0000
priority: P1
related: docs/backlog/done/2026-08-28-portable-fail-closed-unix-client.md
---

## Зачем

The four reported 0.68.0 regressions are fixed in published 0.68.1: paused chunked
resume, Node header limit, managed factory context and NodeNext declarations all pass
their installed probes. This is a separate composition requirement, not a reopening
of those fixes.

A long-lived NDJSON subscription has finite per-frame and buffered-byte limits but
no cumulative lifetime byte limit. The portable Unix adapter accepts only a positive
safe integer `maxResponseBytes` and counts all consumed response bytes against it.
The default terminates a continuously drained valid subscription after 16 MiB.
Increasing the integer only postpones that termination; choosing MAX_SAFE_INTEGER
or automatically reconnecting is not a supported streaming policy.

## Exact installed evidence

Registry `stitchkit@0.68.1`, tag `v0.68.1`,
commit `9ce307b14d06c19cacb3d5c95db406573669e3fd`,
integrity `sha512-OmbKei15tqFfn36RDm3HjRFLameyc8meC2Jj3wwx8Xnj9qC/PEz/OVquu2uegM7L/cVOkQJN7iF/b1XwN6kLDg==`.
Bun 1.3.14, Node 26.7.0, macOS. Install in an isolated directory:
`bun add stitchkit@0.68.1 srvx@0.12.7 zod@4.4.3`.
Save the following as `stream-body-budget.mjs` and run it with Bun and Node.

```js
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnixClientTransport } from 'stitchkit/node';
const socketPath = join(fileURLToPath(new URL('.', import.meta.url)), `budget-${process.pid}.sock`);
const frame = `${JSON.stringify({ value: 'x'.repeat(1000) })}\n`;
const offered = 17_000;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  let written = 0;
  const pump = () => {
    while (!response.destroyed && written < offered) {
      written++;
      if (!response.write(frame)) return;
    }
    if (written === offered) response.end();
  };
  response.on('drain', pump);
  pump();
});
await new Promise(resolve => server.listen(socketPath, resolve));
try {
  for (const maxResponseBytes of [undefined, 32 * 1024 * 1024]) {
    const transport = createUnixClientTransport({ socketPath, maxResponseBytes });
    let received = 0;
    try {
      const response = await transport.fetch('http://local/feed', { signal: AbortSignal.timeout(5000) });
      for await (const chunk of response.body) received += chunk.byteLength;
      console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', maxResponseBytes: maxResponseBytes ?? 'default', received, complete: received === offered * Buffer.byteLength(frame) }));
    } catch (error) {
      console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', maxResponseBytes: maxResponseBytes ?? 'default', received, code: error.code, delivery: error.delivery }));
    } finally { await transport.close(); }
  }
  try { createUnixClientTransport({ socketPath, maxResponseBytes: Infinity }); }
  catch (error) { console.log(JSON.stringify({ unlimitedConfig: 'refused', message: error.message })); }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
```

Both runtimes: default stops at received=16776293 with
`UNIX_RESPONSE_TOO_LARGE`, delivery=response-received.
The 32 MiB positive control consumes all 17221000 bytes successfully.
Infinity is rejected: `maxResponseBytes must be a positive safe integer`.
This fixture is a bounded diagnostic, not an endless workload or a memory benchmark.
The larger setting proves the producer is valid; it is not the proposed solution.

Sources inspected:
`packages/core/src/server/unix-client.ts` (config validation),
`unix-client-body.ts::boundedIncomingBody` (cumulative received),
`unix-client-bun.ts` (cumulative response bytes).
`parseNDJSON({ maxLineBytes })` separately bounds a line, but cannot stop the
underlying adapter from imposing its earlier lifetime limit.

## Результат

An explicit supported Unix streaming-body policy preserves bounded socket/body
buffering and cancellation without an implicit cumulative byte or inactivity cap.
Finite unary responses remain fail-closed and bounded by default.
The owner defines the public API; do not infer mode from Content-Type or a domain ID.

## План

- [x] Define typed configuration/composition for finite unary bodies versus long-lived streams.
- [x] Keep headers, request body, connection count and physical queued-byte ceilings finite.
- [x] Preserve pull-driven backpressure, strict malformed framing and abort/close semantics.
- [x] Add packed Bun/Node proof: drain beyond the unary default, pause/resume, exact content,
      cancel during silence/paused reads and reuse the freed connection slot.
- [x] Publish the implementation, migration example, version/tag/full SHA/integrity.

## Acceptance

- [x] Streaming mode drains well beyond 16 MiB with no lifetime-total rejection or implicit reconnect.
- [x] Unary defaults still reject oversized responses; streaming mode cannot weaken those defaults accidentally.
- [x] The slow-reader plateau and physical retained-byte bounds hold; unlimited buffering is not a solution.
- [x] Installed typed-client/NDJSON composition works on Bun and Node without MAX_SAFE_INTEGER,
      a copied socket/parser engine or fallback transport.

## Что сделано

- Added the discriminated `responseBodyMode: 'bounded' | 'streaming'` Unix client
  configuration. Bounded remains the default; streaming removes only the cumulative
  lifetime response counter and rejects a simultaneous `maxResponseBytes` at both the
  TypeScript and runtime boundaries.
- Kept request, header, connection, framing and queued-byte bounds unchanged in the Node
  and Bun adapters. Backpressure remains pull-driven, and cancellation releases the
  connection slot.
- Documented the contract in ADR 0125, the server/API guides and the 0.68.2 changelog.
- Regression coverage:
  `packages/core/tests/unix-client-transport.test.ts` —
  `streaming response mode removes only the cumulative response ceiling`,
  `Bun pauses and resumes a chunked producer without corrupting framing`, and
  `close interrupts an active body once and the finite connection cap refuses without queueing`.
- Packed consumer coverage:
  `packages/core/scripts/consumer-lane/fixtures/minimal/src/unix-client-conformance.mjs`
  proves the bounded rejection, 17,000 ordered typed NDJSON frames beyond 16 MiB,
  stalled-reader backpressure, cancellation/slot reuse and invalid mixed configuration
  on both Bun and Node.
- `bun run verify` passed for the release tree. Exact-SHA CI run `33152053357` passed.
- Published `stitchkit@0.68.2`, tag `v0.68.2`, commit
  `2286cfc13e61b60aa551fd90fc6ee1174a30f32b`, integrity
  `sha512-qtQJ6EHTKZ1VfqNy6sPi0jlaXaachTF+4NK297fSMAJlw55mqO2gl6IW5z0+B+e4UaODg07YXOeNLurZxFlD7g==`.
