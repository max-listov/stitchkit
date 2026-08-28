---
title: Generic transport primitives for composable applications
description: Generic transport primitives for composable applications with explicit ownership, bounds and published conformance evidence.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 05:08 +00:00
pipeline: transport-primitives
order: 0
depends-on: —
---

## Зачем

Typed local clients and long-lived feeds repeat byte bounds, cancellation, resource accounting and queue semantics. The framework already owns contracts, HTTP/realtime adapters and process-local lifecycle; this program extends those surfaces instead of introducing another client or transport engine.

## Результат

Four independently specified primitives, each available from an installable published package with a generic example, migration guidance and executable conformance evidence.

## Порядок и границы

| ID | Task | Existing surface |
|---|---|---|
| K1 | `2026-08-28-portable-fail-closed-unix-client.md` | ClientFetch / createHttpClient |
| K2 | `2026-08-28-contract-first-bounded-streams.md` | defineContract / streamingRoute / parseNDJSON |
| K3 | `2026-08-28-bounded-operation-admission-leases.md` | application admission / cancellation |
| K4 | `2026-08-28-bounded-delivery-channels.md` | event bus / application snapshot sink |

Order is the recommended execution order, not a dependency on another project's work. K1 and K2 share client exports/docs and should be integrated serially by the maintainer. K3 and K4 must agree on accounting vocabulary but neither should require an unfinished implementation of the other. A coherent release may contain several completed tasks; do not publish partial exports.

The framework remains process-local and Web Fetch-clean at its shared/browser boundary. No broker topology, authentication inventory, command profiles, external deployment policy or domain DTOs. Do not replace Socket.IO. Runtime-specific Unix code must stay behind an appropriate explicit entrypoint. One factory for every possible distributed system is not the objective.

## План

- [x] Recheck the current release and existing exports; preserve completed Unix/stream/lifecycle guarantees.
- [x] Complete K1 and K2 without duplicating the typed client or framing engine.
- [x] Complete K3 and K4 with deterministic resource-lifetime and memory bounds.
- [x] Document public API decisions in ADRs plus the ADR index; update guides, reference and generated-doc sources.
- [x] Publish the coherent package through the repository's canonical full verification and exact-SHA CI flow.

## Acceptance

- [x] Each child task names exact public import paths, schemas, defaults, failure semantics and changed behavior.
- [x] Packed consumers prove Bun and Node behavior, not source-only imports; browser imports remain clean.
- [x] At least two generic scenarios exercise each abstraction without private application vocabulary.
- [x] Release evidence includes version/tag/full commit SHA, package integrity, exact test cases and executable migration examples.
- [x] No claim of downstream adoption or distributed durability is made.

## Выполнено до публикации

- K1 extends the existing `ClientFetch` seam through `stitchkit/server` and
  `stitchkit/node`; K2 extends `defineContract`, `createHandler` and
  `createClient`; K3 and K4 extend `stitchkit/application`.
- ADRs 0116–0119 and their index rows fix transport selection, stream
  termination, lease lifetime and queue policy as separate decisions.
- `packages/core/scripts/consumer-lane/` compiles and executes the installed
  tarball on Bun and Node. The Node declaration lane has no Bun ambient types;
  the browser-clean build check remains green.
- Exact child regression cases and migration examples are recorded in the four
  child tasks. Publication evidence remains deliberately open until the tag
  and registry artifact exist.

Replay/cursor algebra and prepared-file snapshot helpers are not silently included. They need evidence of a distinct reusable gap beyond existing file and lifecycle surfaces before a separate implementation task is promoted.

## Release evidence

- Version/tag: `stitchkit@0.68.0` / `v0.68.0`.
- Release commit: `8c64154f77aabce65f57948ab2c7cb29a0dcae34`.
- Exact-SHA CI: run `33143691824`, all framework, PostgreSQL, packed Bun/Node,
  starter matrix and supervised jobs green.
- Publication: run `33143846432`; GitHub release
  `https://github.com/max-listov/stitchkit/releases/tag/v0.68.0`.
- Registry integrity:
  `sha512-tugTbOXIVyUu7js/HfdRunE6lc8/9fNMBureorJX5UA/nfkghT0avyG9E6Ej0a5+QnnlBngnj57z2y/BLCYhxA==`;
  shasum `a2269ad0a3ba2114dbb6057eeb76fe2f1d99964d`.
- Local canonical gate: `bun run verify`, green for exact working-tree hash
  `ca65e9d3ca75`; both implementation and release snapshots were gated whole.
- Executable migrations live in `docs/guide/upgrading.md`; exact test cases and
  installed-artifact examples are attested in the child tasks below.
