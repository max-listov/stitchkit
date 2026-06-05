---
title: Span/parentSpanId context — investigation (not a core gap)
description: Migration M1 — consumer audit writes ctx.spanId/parentSpanId but the handler ctx carries only traceId. Investigated whether stitch should populate span ids on ctx. Conclusion — no core change; span lives in the observability request context. Documented.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 03:00
related: docs/decisions/0012-observability-module.md
---

# Span context — investigation

**Type: DECIDE (investigate).** From the migration review M1: the consumer's audit
writes `ctx.spanId` / `ctx.parentSpanId`, but `createAppHandler`/MCP context pass
only `traceId`, so those fields are always `undefined`.

## Investigation

- `buildContext` (`server/context.ts`) populates `ctx.traceId` from the resolved
  trace id string — and **not** `spanId`. The server core deliberately deals in a
  single `traceId`.
- The full W3C trace (`{ traceId, spanId, parentSpanId }`) lives in the
  **observability** request context (ALS), reachable via `getRequestContext()?.trace`
  when running inside `runWithRequestContext` (which `createAuditHook` /
  `wrapInRequestContext` set up). `createTraceContext` mints `spanId`; each tool
  call opens a `childSpan`.

## Verdict — NOT a stitch core gap

Stuffing `spanId`/`parentSpanId` onto the handler `ctx` would couple the core
context-builder to the observability layer on the hot path, for a field most
consumers don't read. The trace (with span ids) is already available where audit
runs — via `getRequestContext()?.trace`. The fix is consumer-side wiring (read the
trace from the request context), not a core change.

## Что сделано (2026-06-05)

- [x] **Investigated** `buildContext` + observability trace context — confirmed
  the core carries `traceId` only; span ids live on the observability request
  context by design.
- [x] **Documented** in `guide/observability.md` (Trace context): "span ids live
  in the request context, not on `ctx`" + the `getRequestContext()?.trace` pattern.
  CHANGELOG (Docs).
- [x] **No core code change** — rejected populating `ctx.spanId` (hot-path
  coupling, low value). Consumer reads span from the request context.
- [x] **consumer-side (M1):** inject span fields in `beforeHandle` from
  `getRequestContext()?.trace`, or drop the dead `ctx.spanId` reads — their call.

**Verdict:** resolved, no stitch code. Tracked with the **0.7.0** batch.
