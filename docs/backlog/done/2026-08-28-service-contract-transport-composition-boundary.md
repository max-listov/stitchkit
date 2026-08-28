---
title: Keep service contracts independent of delivery adapters and deployment policy
description: Verify typed-client transport composition and publish generic guidance without moving application semantics into the framework.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
related: docs/backlog/done/2026-08-28-transport-primitives-program.md
---

## Зачем

A service owns operation names, request/response schemas and domain outcomes. A delivery
adapter owns I/O, bounds and dispatch uncertainty. An application composes them. Embedding
service-specific schemas or endpoint inventories into a transport/framework couples releases
that should be independent.

The existing typed-client/ClientFetch extension seam and the active transport-primitives
program may already cover the required mechanics. This task asserts no new missing API:
inspect and reproduce against a published package before changing implementation.

## Результат

An installable, documented composition where an application-owned typed service client uses
an injected delivery adapter without copying its domain DTOs into the adapter or framework.
No new competing client, generic service registry, distributed authorization system or
deployment controller is introduced.

## Scope relative to active work

- K1 `2026-08-28-portable-fail-closed-unix-client.md` owns Unix I/O, redirect handling,
  bounded bodies and Bun/Node cancellation. Do not implement those again here.
- K3 `2026-08-28-bounded-operation-admission-leases.md` owns process-local admission
  accounting. External service authorization and deployment policy stay outside it.
- K2/K4 are required only if the concrete example consumes their published interfaces;
  completing every program task is not an artificial prerequisite for a unary example.
- `2026-08-28-managed-server-factory-resource-context.md` remains the sole factory-context
  implementation task. This task must not create a second lifecycle implementation.

## План

- [x] Audit the existing contract, typed-client, ClientFetch and error surfaces. Identify
      the exact public imports and supported way to inject request delivery and cancellation.
- [x] Build a minimal generic example with application-owned query and request-work
      operations, typed inputs/outputs and an injected transport; no application identifiers,
      machine paths, domain models or downstream repositories in source/docs/fixtures.
- [x] Separate application effect declarations from authorization: metadata is not a grant.
      A deployment adapter chooses its fixed endpoint and policy; the caller payload cannot
      override a reserved operation identity. Do not make Stitchkit the policy authority.
- [x] Verify serialization/output validation has one owner and does not require a second
      schema copy or a hand-written competing typed client. Define compatible response reading,
      contract-version mismatch and explicit unknown remote outcomes.
- [x] Verify request cancellation/deadline can be propagated through the seam; preserve
      not-dispatched, possibly-dispatched and received-response outcomes. A timeout cannot
      imply that a side effect did not happen; the example does not replay automatically.
- [x] If existing published APIs suffice, deliver precise guide/reference changes and a
      packed composition test only; do not add a speculative abstraction.
- [x] If a concrete reusable gap is reproduced, add exact evidence to the matching existing
      primitive task. Implement only the uncovered seam in this task when no existing task
      owns it; preserve the public/private boundary and normal ADR/release rules.
- [x] Record supported versions, public imports, defaults/limits and a minimal migration.
      Update generated-doc sources, not generated outputs by hand.

## Acceptance

- [x] Packed consumers on supported Bun and Node runtimes instantiate the typed client
      with injected delivery outside the source checkout; typecheck and runtime behavior pass.
- [x] Browser-safe contract imports do not import node I/O, start services, read configuration
      or require deployment credentials; server-only adapters stay explicit.
- [x] Two different application contract shapes work without modifying framework or delivery
      adapter source. Operation-policy enforcement is tested by the composing application,
      not claimed from an effect label alone.
- [x] No-dispatch failure, post-dispatch timeout, cancellation while reading, oversized body
      and a received domain failure remain distinguishable through the client boundary.
- [x] K1's installed Unix/TCP-sentinel and sustained backpressure gates remain required for
      any adopted Unix path; this task does not reclassify a red primitive as documentation-only.
- [x] Completion records exact test names, package version/tag/full SHA and registry integrity
      when a package release is needed. Documentation-only sufficiency is an explicit verdict;
      no downstream deployment or adoption is claimed.

This inbox item is a composition/boundary task, not an instruction to stop or duplicate the
active primitive implementation. Work begins through the repository's normal execution flow.

## Reproduced packed NodeNext declaration blocker (2026-08-28)

Priority P1. Registry `latest` is stitchkit0.67.0; integrity:
`sha512-rpE+YtW/tLYJOqV4Yj0GfpZ68Ge1rYqg+TZDnycgJBsTYqYe9S4/fCNvOwHg7hUlcIwzsNsQxamp4lYKLxlJqw==`.
Standalone ESM consumer, TypeScript7.0.2, Node26.7.0, Bun1.3.14. No workspace aliases,
dependency patches or skipLibCheck. The typed-client runtime works, but the published
declarations fail `tsc --noEmit --module nodenext --target es2022 example.ts`.

Minimal consumer (install exact stitchkit0.67.0, zod4.4.3, typescript7.0.2):

```ts
import { createClient, defineContract } from 'stitchkit';
import { z } from 'zod';
const contract = defineContract({ prefix: '/example' }, {
  read: { method: 'POST', path: '/read', desc: 'Read example', input: z.strictObject({}), output: z.object({ ok: z.boolean() }) },
});
const client = createClient(contract, {
  baseUrl: 'https://example.invalid',
  fetch: async () => Response.json({ ok: true }),
});
if (!(await client.read({})).ok) throw new Error('Invalid response');
```

Actual result: exit1, ten TS2834 diagnostics in `dist/index.d.ts` lines1–10, followed
by TS2305 for `defineContract`. Published root declaration uses extensionless exports
such as `./browser/client` and directory export `./contract`; source `src/index.ts`
uses the same specifiers. Downstream declaration emit also loses resolvable
`ContractDef`/`ScopedHttpClient` through that root under NodeNext.

A second isolated check with `--module esnext --moduleResolution bundler` still exits1:
TS2307 in `dist/browser/socket-io.d.ts:23`, required type import from
`@socket.io/component-emitter` despite this being an optional peer and an HTTP-only
composition. The root declaration exports Socket.IO types unconditionally. The clean
HTTP-only package gate must not silently depend on optional peers installed elsewhere in
the workspace. Both findings are published-declaration packaging, not runtime HTTP failures.

- [x] Correct package declaration emission/export resolution at the owner, not by requiring
      consumer skipLibCheck, changing consumers to bundler resolution or patching node_modules.
- [x] Add clean packed NodeNext typecheck (skipLibCheck=false) plus Bun/Node runtime composition
      to the existing public consumer gates, including inferred typed-client declaration emit.
- [x] Publish the fixed package and record exact version/tag/full SHA/registry integrity.

This is the concrete packaging portion of the existing composition task, not a second
transport implementation or a requirement to finish every primitive before unary clients.

## Revalidated against published 0.68.0

The blocker is still reproduced with registry latest0.68.0, tagv0.68.0, commit
`8c64154f77aabce65f57948ab2c7cb29a0dcae34`, registry integrity
`sha512-tugTbOXIVyUu7js/HfdRunE6lc8/9fNMBureorJX5UA/nfkghT0avyG9E6Ej0a5+QnnlBngnj57z2y/BLCYhxA==`.
Clean installed typed-client composition outside every source checkout:
install/Bun1.3.14/Node26.7.0 runtime pass; TypeScript7.0.2 NodeNext fails with TS2834
and downstream TS2694; bundler resolution fails with TS2307 optional component-emitter.
Both type gates run with `skipLibCheck=false`. The release-tag source still has
extensionless root exports and the unconditional optional EventsMap type import.

The new bounded primitives do not close these package declaration gates. Required next
result is this existing task's declaration/optional-peer fix, clean packed consumer tests,
and a published patch with exact version/commit/integrity. No consumer workaround requested.


## In-process tool entrypoint requires unrelated runtime peers (0.68.0)

A CLI-only Bun consumer installed with stitchkit0.68.0 and zod4.4.3 can use
`stitchkit/cli` without MCP/AI peers. The documented in-process invoker fails at import:

```sh
bun -e 'import { createToolInvoker } from "stitchkit/tools"; console.log(typeof createToolInvoker)'
```

Actual: exit1, `Cannot find module '@modelcontextprotocol/server' from
'node_modules/stitchkit/dist/tools.js'`. In tag v0.68.0,
`packages/core/src/tools.ts` exports both `createToolInvoker` from `tools/invoker`
and `mountMcp` from `tools/mcp`; the latter statically imports the MCP SDK.
`invoker.ts` composes the shared runner without requiring an MCP mount itself.
This runtime entrypoint coupling is distinct from the declaration failures above.

- [x] Provide/document a supported public import for in-process contract tool
      dispatch without MCP/AI peers when neither adapter is used. Keep one runner;
      no consumer shim or private dist import.
- [x] Test that import and a CLI-exposed contract invocation in a clean packed
      Bun/Node consumer without MCP/AI peers, including validation and errors.
- [x] Publish the packaging result with exact version/tag/SHA/integrity alongside
      the declaration fixes tracked here.

The public CLI adapter remains usable, including its injectable stdout/stderr/exit
for exercising the real CLI pipeline. No extra SDK dependency is requested.


## Packed browser Socket.IO warning with the supported peer loader (0.68.0)

Published stitchkit 0.68.0, Next.js 16.3.2 with `next build --webpack`, React 19.2.8,
socket.io-client 4.8.3, Bun 1.3.14. Build exits 0 but emits:
`Critical dependency: the request of a dependency is an expression` from
`stitchkit/dist/index.js`, imported by a client component using the public root.
The warning persists WITH the documented loader:

```ts
import { createSocketIOClient } from 'stitchkit';
const client = createSocketIOClient({
  url: 'http://localhost:4000',
  peers: { client: () => import('socket.io-client') },
});
```

Published root still contains `import(SOCKET_IO_CLIENT)` in the fallback loader;
Webpack analyzes that branch even when the application injects a literal loader.
Source: `packages/core/src/browser/socket-io.ts`, `loadIo`. No browser subpath
exists in the published exports; no internal imports or consumer warning suppression
are an acceptable fix. The injected loader is the supported runtime composition,
not evidence that the packed browser build is warning-free.

- [x] Provide a supported warning-free packed browser path while preserving optional
      peer isolation and lazy loading; test a Next/Webpack client fixture with the
      documented loader and reject critical dependency warnings.
- [x] Publish the packaging fix with exact version/tag/SHA; preserve existing NodeNext
      and optional-peer gates from this task.

## Что сделано

- [x] `packages/core/scripts/rewrite-declaration-specifiers.mjs` emits explicit
      NodeNext-resolvable `.js`/`index.js` declaration targets; the root owns its
      peer-free Socket.IO event constraint.
- [x] Packed NodeNext proof: `packages/core/scripts/consumer-lane/fixtures/nodenext/src/app.ts`
      and `runtime.mjs` exercise two different generic contracts through one
      injected `ClientFetch` with `skipLibCheck: false` and no optional peer.
- [x] `packages/core/src/browser/client.ts` retains injected transport failure
      causes. Regression: `packages/core/tests/unix-client-transport.test.ts` —
      `typed-client cause preserves not-dispatched and post-dispatch timeout states`,
      `typed-client cancellation and response bounds remain distinguishable`, and
      `typed-client received domain failure stays an ApiError response`.
- [x] `stitchkit/tools/invoker` provides the peer-free canonical runner. Packed
      proof `tool-invoker-conformance.mjs` executes success, validation and
      normalized unknown-tool failure on Bun and Node.
- [x] `packages/core/scripts/next-ssr-retry-smoke.mjs` builds a real packed
      Next/Webpack client with the literal Socket.IO loader and refuses the
      former critical dependency warning. ADRs 0120 and 0122, guides, reference
      and changelog describe the supported boundaries.
- [x] The generated repository example uses the same literal loader. The packed
      HEAD starter lane proves its real WebSocket connection and realtime cache
      update in Chromium, WebKit and mobile Chromium.
- [x] Full `bun run verify` passed. Package release is `0.68.1`, immutable tag
      `v0.68.1`; exact SHA and registry integrity are reported from the release
      and registry authorities after publication.
