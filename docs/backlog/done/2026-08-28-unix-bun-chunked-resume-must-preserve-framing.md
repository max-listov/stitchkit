---
title: Unix Bun adapter must preserve chunked framing across paused-reader resume
description: A bounded reader pause must resume a valid response without corrupting chunk delimiters.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: P1
related: docs/backlog/done/2026-08-28-portable-fail-closed-unix-client.md
---

## Зачем

The new adapter bounds a stalled reader, but resuming that reader fails on a valid chunked HTTP body.
A stall-only plateau is not sufficient acceptance: callers must also finish after resumption.

## Published reproduction

Published registry stitchkit@0.68.0, tag v0.68.0, commit
`8c64154f77aabce65f57948ab2c7cb29a0dcae34`, integrity
`sha512-tugTbOXIVyUu7js/HfdRunE6lc8/9fNMBureorJX5UA/nfkghT0avyG9E6Ej0a5+QnnlBngnj57z2y/BLCYhxA==`.
Bun 1.3.14 and Node 26.7.0, macOS; independent installed consumer outside the source checkout.
Install `stitchkit@0.68.0` and documented Node entrypoint peer `srvx@0.12.7`.

Save as `backpressure.mjs` in the installed consumer and run `bun backpressure.mjs`,
`node backpressure.mjs`, then `bun backpressure.mjs --native`.

```js
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createUnixClientTransport } from 'stitchkit/node';
const socketPath = join(fileURLToPath(new URL('.', import.meta.url)), `pressure-${process.pid}.sock`);
let written = 0;
let stopped = false;
const frame = `${JSON.stringify({ data: Buffer.alloc(32768, 120).toString('base64') })}\n`;
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const pump = () => { while (!stopped && written < 512) { written++; if (!res.write(frame)) return; } if (!stopped && written === 512) res.end(); };
  res.on('drain', pump); pump();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
const client = createUnixClientTransport({ socketPath, maxResponseBytes: 64 * 1024 * 1024 });
try {
  const native = process.argv.includes('--native');
  const response = native
    ? await fetch('http://local/feed', { unix: socketPath, signal: AbortSignal.timeout(3000) })
    : await client.fetch('http://local/feed', { signal: AbortSignal.timeout(3000) });
  const reader = response.body.getReader();
  let bytes = (await reader.read()).value.byteLength;
  await delay(100); const at100 = written;
  await delay(100); const at200 = written;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; }
  } catch (error) {
    console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', native, at100, at200, written, bytes, resumed: false, code: error.code, cause: error.cause?.message }));
    throw error;
  }
  reader.releaseLock();
  const resumed = written === 512 && bytes === Buffer.byteLength(frame) * 512;
  console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', native, offered: 512, at100, at200, bounded: at200 < 512 && at100 === at200, resumed }));
  if ((!native && (at200 === 512 || at100 !== at200)) || !resumed) process.exitCode = 1;
} finally { stopped = true; await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
```

Observed adapter Bun: at100=1, at200=1, written=2, bytes=46574, resumed=false;
`UNIX_RESPONSE_ABORTED` with cause `Unix chunked response has an invalid chunk delimiter`, exit 1.
Node adapter: at100=4, at200=4, bounded=true, resumed=true, exit 0.
Native Bun fetch: at100=512, at200=512, resumed=true, exit 0 (not bounded).

The native control is only evidence that this producer emits a readable body; it is not a proposed fallback.
Source inspected: `packages/core/src/server/unix-client-bun.ts`, pause/resume and
`pumpChunked` state transitions. Exact parser root cause still requires owner diagnosis.

## Результат

One bounded Bun transport preserves a valid chunked body through pause/resume and cancellation.
No fallback, consumer parser copy or relaxation of malformed framing validation.

## План

- [x] Reproduce on the published artifact and diagnose parser/socket state transitions.
- [x] Fix the owner implementation; cover split headers, sizes, data, delimiters and EOF.
- [x] Add installed Bun/Node pause → plateau → resume → exact body and cancellation gates.
- [x] Publish a patch with full verification and exact version/tag/SHA/registry integrity.

## Acceptance

- [x] The fixture finishes with bounded=true and resumed=true on both adapters.
- [x] Verify exact content/order, not only the byte count; malformed chunked input still refuses.
- [x] Cancellation during a pause releases capacity and leaves no socket/reader leak.
- [x] A clean installed consumer passes; source-only tests do not close the issue.

## Что сделано

- [x] `packages/core/src/server/unix-client-bun.ts` commits chunk framing state
      before `enqueue`, preventing a synchronous re-entrant pull from consuming
      the delimiter as payload.
- [x] Regression: `packages/core/tests/unix-client-transport.test.ts` —
      `Bun pauses and resumes a chunked producer without corrupting framing` and
      `Bun still refuses malformed chunk delimiters`.
- [x] Packed proof: `packages/core/scripts/consumer-lane/fixtures/minimal/src/unix-client-conformance.mjs`
      runs plateau → exact ordered resume and cancellation/slot reuse on Bun and
      Node from the tarball.
- [x] Full `bun run verify` passed; release evidence is attached to immutable
      tag `v0.68.1` and its registry artifact.
