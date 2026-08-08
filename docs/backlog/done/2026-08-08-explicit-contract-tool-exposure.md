---
title: Explicit tool exposure policy for contract factories
description: Let security-sensitive applications make missing expose mean HTTP-only without changing the global contract default.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 06:53 +00:00
---

# Explicit tool exposure policy for contract factories

## Problem

An endpoint without `expose` is currently available over HTTP, MCP and Agent.
That remains convenient for small contract-first APIs, but in a backend with a
curated tool surface an ordinary HTTP endpoint can become model-callable merely
because its author omitted one field.

## Decision

Do not change the global default. Add an opt-in factory policy:

```ts
const { defineContract } = createContractFactory<AppScope>({
  toolExposure: 'explicit',
});
```

Under this policy an omitted `expose` is materialized as `['HTTP']`; MCP, Agent
or CLI exposure requires an explicit endpoint declaration. Use one semantic
mode rather than a generic default-transports bag: it states the security
intent and avoids turning factory configuration into a second transport DSL.

## Plan

1. Add a typed optional config to `createContractFactory`; the no-argument form
   retains today's all-surface default exactly.
2. In explicit mode, materialize missing endpoint exposure to HTTP-only before
   the contract reaches any router, client, OpenAPI or tool collector.
3. Preserve explicitly supplied exposure arrays verbatim, including tool-only
   endpoints and CLI opt-in.
4. Reflect the materialized exposure in the returned endpoint types without
   casts or compatibility wrappers.
5. Test HTTP routing, MCP/Agent/CLI collection, manifests, OpenAPI, clients and
   mixed explicit/implicit endpoints.
6. Add a security-focused guide section, API reference entry, generated consumer
   docs and changelog note.

## Acceptance

- [x] In `toolExposure: 'explicit'` mode an endpoint without `expose` is served
  over HTTP and absent from MCP, Agent and CLI surfaces.
- [x] Explicit `['HTTP', 'AGENT']`, MCP-only and CLI-only declarations retain
  their exact semantics.
- [x] The factory's existing no-config behaviour remains unchanged.
- [x] Introspection helpers and real mounts report the same surface.
- [x] The returned types describe the materialized exposure and preserve scope,
  schemas and endpoint literals.
- [x] Definition, transport, OpenAPI and packed-consumer tests pass.

## Что сделано

- [x] **Contract policy:** `createContractFactory({ toolExposure: 'explicit' })`
  materializes omitted exposure as `['HTTP']` before every downstream surface —
  `packages/core/src/contract/factory.ts`.
- [x] **Types/tests:** returned endpoint type carries the materialized tuple;
  explicit MCP/Agent declarations and unchanged no-config behavior are covered in
  `packages/core/tests/contract-factory.test.ts`.
- [x] **Architecture:** ADR 0062 fixes the policy at the authoring boundary and
  explicitly avoids contract-level inheritance.
- [x] **Docs/gates:** contracts guide, reference, changelog and generated consumer
  docs are current; full transport/OpenAPI/packed-consumer `bun run verify` green.
