---
title: Contract-derived surface conformance smoke
description: Replace demo-name assertions with a generic manifest check and explicit fixtures for operations that can be invoked safely.
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 13:39 +07:00
---

## Зачем

The starter runtime smoke correctly exercises a packed consumer path, but its
assertions name the repository endpoint, tool and socket event directly. Replacing
the example therefore means rewriting infrastructure validation. Stitchkit can
derive surface membership mechanically, but it cannot invent valid inputs,
authentication or safe side effects for every domain operation.

## Результат

The generated runtime smoke automatically verifies that declared HTTP and tool
surfaces agree with OpenAPI, MCP discovery and the service registry. Consumers add
small explicit fixtures only for operations they intentionally execute; domain E2E
scenarios remain separate.

## План

- [x] Define a transport-neutral surface manifest containing operation identity, HTTP exposure/path/method and MCP/AGENT/CLI names derived from registered services.
- [x] Reuse existing public contract/tool introspection where possible; add a core public collector only for information that cannot be obtained without private internals.
- [x] Add a conformance runner that compares the manifest against live OpenAPI paths and MCP discovery without invoking business handlers.
- [x] Add an explicit typed probe registry for safe HTTP/tool calls with input fixtures and optional output assertions.
- [x] Keep Socket.IO connectivity/lifecycle smoke generic; event semantics belong to explicit realtime fixtures or domain tests.
- [x] Refactor blank and repository-example runtime smokes onto the same runner.
- [x] Test mismatched registration, missing OpenAPI operation, missing/extra MCP tool, duplicate identity and invalid probe fixture diagnostics.
- [x] Document what conformance proves and what still requires domain E2E coverage.

## Acceptance

- [x] No framework-level smoke assertion contains a repository endpoint, event or tool name.
- [x] Every exposed HTTP operation is represented consistently in the manifest and OpenAPI.
- [x] MCP discovery exactly matches the manifest after exposure policy and runtime tools are applied.
- [x] Business handlers are called only when the consumer supplies an explicit typed probe fixture.
- [x] Failure messages identify the contract, transport and expected/actual surface entry.
- [x] Blank and example packed starter lanes both exercise the generic conformance runner.

## Что сделано

- [x] Manifest: generated applications derive HTTP/tool entries in `packages/create-stitchkit/template/packages/backend/src/surface-manifest.ts`.
- [x] Runner: `packages/create-stitchkit/template/scripts/surface-conformance.ts` compares exact OpenAPI and MCP discovery surfaces and runs only explicit probes.
- [x] Modes: blank and repository example runtime smokes use the same conformance runner.
- [x] Diagnostics/tests: mismatches, extras, duplicates and probe validation are covered by `packages/create-stitchkit/template/packages/backend/src/surface-manifest.test.ts` and packed lanes.
