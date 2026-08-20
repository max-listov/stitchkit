---
title: "ADR 0089: Async operations describe transport, not jobs"
description: One descriptor links start/status/wait/cancel/result/artifacts while storage, execution and domain transitions stay in the application.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0089 — Async operations describe transport, not jobs

## Context

Long-running exports, imports and generation jobs repeat the same operation
surface, but Stitchkit must not become a queue, scheduler or persistence layer.

## Decision

`defineAsyncOperation({ mode:'runtime-only' })` generates ordinary pathless
runtime definitions for start, status and wait plus configured cancel, result
and artifacts capabilities. Missing optional capabilities are absent from the
inferred keys and discovery. `bindContractAsyncOperation({
mode:'contract-backed' })` instead binds literal methods from an existing
dedicated contract; it creates no router and requires start/status/wait to use
schema-compatible id/snapshot types. Typed callers therefore cannot select an
incompatible endpoint. Runtime identity checks remain defence-in-depth for
untyped callers and require the same Zod instances, so a dedicated contract
should still declare each id/snapshot schema once and reuse it.

Applications map inspected state to the canonical `pending | running |
succeeded | failed | cancelled` snapshot schema. Stitchkit validates each
snapshot but stores no history and enforces no monotonic transition. Every
follow-up first runs the mandatory resource `authorize` callback. Result and
artifacts receive the already-inspected state and only run for `succeeded`, so
there is no hidden second lookup. Cancel returns the validated `accepted |
already_terminal | rejected` envelope; aborting wait never calls cancel.
Every capability, including wait, uses its own `<action>.<capability>` identity
and optional per-capability scope override.

`pollUntil` owns one monotonic absolute deadline, caps each sleep to the
remaining budget and passes a linked caller/deadline signal to cooperative
polls. Non-cooperative callbacks cannot be force-stopped. HTTP, MCP and Agent
carry transport cancellation; CLI accepts an explicit signal and leaves OS
SIGINT binding to the application.

## Consequences

- Queue/storage, leases, retries, id uniqueness, domain states and authorization
  decisions remain application-owned.
- Failed snapshots contain only application-supplied caller-safe failure data;
  raw provider causes stay in existing internal observability.
- Progress is application-defined typed data. Realtime delivery remains an
  ordinary Socket.IO contract over the same status model.
