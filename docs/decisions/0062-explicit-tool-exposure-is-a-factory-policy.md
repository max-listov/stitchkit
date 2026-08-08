---
title: "ADR 0062 — Explicit tool exposure is an opt-in factory policy"
description: Security-sensitive applications can materialize omitted endpoint exposure as HTTP-only without changing the global contract default.
type: decision
status: accepted
created: 2026-08-08
updated: 2026-08-08
---

# ADR 0062 — Explicit tool exposure is an opt-in factory policy

- **Status:** Accepted — refines the strict-factory alternative deferred by
  [ADR 0036](0036-contract-level-meta.md); the rejection of contract-level
  `expose` inheritance still stands.
- **Date:** 2026-08-08

## Context

Missing `expose` intentionally means HTTP, MCP and Agent for ordinary contracts.
That is productive for small contract-first surfaces, but a backend that curates
model-callable operations needs the opposite security posture: adding an HTTP
endpoint must not implicitly widen a tool surface.

Contract-level inheritance remains the wrong solution. Moving an unchanged
endpoint between contracts would silently change its exposure, and forgetting
the field at both levels would preserve the original hole.

## Decision

`createContractFactory({ toolExposure: 'explicit' })` changes how that factory
materializes endpoint definitions. An omitted `expose` becomes the concrete
`['HTTP']` tuple before `defineContract` validation and before any router,
client, OpenAPI or tool collector sees the contract. Explicit endpoint arrays
remain unchanged.

The materialized field is part of the returned endpoint type. This is not
inheritance and not a mount-time fallback: every downstream surface reads the
same explicit contract data.

The no-config factory and plain `defineContract` retain the default-on tool
policy. Applications choose the posture once at their own contract-authoring
boundary.

## Consequences

- A security-sensitive application can make every tool transport opt-in without
  changing the global default or repeating `expose: ['HTTP']`.
- Moving an endpoint between contracts created by the same factory is
  exposure-neutral because the returned endpoint already carries `expose`.
- Moving code between factories with different policies is an intentional
  authoring-boundary change and produces a type/runtime surface diff.
- Tool-name snapshots remain useful as a second, independent surface gate.
