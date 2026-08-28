---
title: Unix Node adapter must enforce the configured response header byte ceiling
description: A lower maxHeaderBytes value must not silently fall back to the runtime header limit.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: P1
related: docs/backlog/done/2026-08-28-portable-fail-closed-unix-client.md
---

## Зачем

The published Node adapter ignores the caller's configured `maxHeaderBytes`.
A default Node HTTP ceiling is not the explicitly requested smaller bound.
The same config already refuses the oversized header on Bun.

## Published reproduction

Published registry stitchkit@0.68.0, tag v0.68.0, commit
`8c64154f77aabce65f57948ab2c7cb29a0dcae34`, integrity
`sha512-tugTbOXIVyUu7js/HfdRunE6lc8/9fNMBureorJX5UA/nfkghT0avyG9E6Ej0a5+QnnlBngnj57z2y/BLCYhxA==`.
Bun 1.3.14 and Node 26.7.0, macOS; independent installed consumer outside the source checkout.
Install `stitchkit@0.68.0` and documented Node entrypoint peer `srvx@0.12.7`.

Save as `unix-probe.mjs` in the installed consumer and run it with Bun and Node.

```js
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnixClientTransport, UnixClientTransportError } from 'stitchkit/node';

const socketPath = join(fileURLToPath(new URL('.', import.meta.url)), `probe-${process.pid}.sock`);
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'x-large': 'x'.repeat(2048) });
  res.end('{}');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
const outcomes = [];
try {
  for (const maxHeaderBytes of [256, 4096]) {
    const client = createUnixClientTransport({ socketPath, maxHeaderBytes, maxResponseBytes: 16, maxRedirects: 0 });
    try {
      const response = await client.fetch('http://local/test', { signal: AbortSignal.timeout(1000) });
      outcomes.push({ maxHeaderBytes, result: 'received', body: await response.text() });
    } catch (error) {
      outcomes.push({ maxHeaderBytes, result: 'refused', code: error instanceof UnixClientTransportError ? error.code : String(error) });
    } finally { await client.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', outcomes }));
if (outcomes[0]?.result !== 'refused' || outcomes[1]?.result !== 'received') process.exitCode = 1;
```

Bun: 256 → refused `UNIX_HEADERS_TOO_LARGE`; 4096 → received `{}`, exit 0.
Node: both 256 and 4096 → received `{}`, exit 1.
The larger-limit control proves a valid response, rather than an indiscriminate refusal.

Source: `packages/core/src/server/unix-client.ts` parses the option and passes it to
the Bun branch; its Node `httpRequest` has no corresponding `maxHeaderSize`
or response-head byte check.

## Результат

Node and Bun enforce the documented configured response-head ceiling with a stable typed failure.
No consumer-side duplicate validation.

## План

- [x] Reproduce with a clean registry install and define exact header-byte accounting.
- [x] Enforce the bound in the Node path, including typed error and delivery mapping.
- [x] Cover below/equal/above limits, low custom bounds, cleanup and slot reuse on refusal.
- [x] Publish a patch with full verification and exact version/tag/SHA/registry integrity.

## Acceptance

- [x] Both runtimes refuse the small-limit case with `UNIX_HEADERS_TOO_LARGE` and accept the control.
- [x] Refusal releases the request/response and connection slot.
- [x] Installed-package regression gates cover both runtimes; no silent runtime-default substitution.

## Что сделано

- [x] `packages/core/src/server/unix-client.ts` passes the configured integer to
      Node `http.request({ maxHeaderSize })` and normalizes
      `HPE_HEADER_OVERFLOW` to `UNIX_HEADERS_TOO_LARGE` with a received-response
      delivery state.
- [x] Bun accounts through the terminating CRLFCRLF; Node follows its native
      parser accounting. Both exact boundaries are pinned below/equal/above in
      `packages/core/scripts/consumer-lane/fixtures/minimal/src/unix-client-conformance.mjs`.
- [x] The same packed proof refuses a 2 KiB header at 256 bytes, accepts it at
      4096, then reuses the refused transport's connection slot successfully.
- [x] Full `bun run verify` passed; release evidence is attached to immutable
      tag `v0.68.1` and its registry artifact.
