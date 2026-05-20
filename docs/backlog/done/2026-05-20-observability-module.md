---
title: Observability module — audit logging built in
description: stitchkit should own the reusable audit layer (trace context, request context, normalized events, sanitisation, hook wiring) so a consuming project's logging is just a table plus a write function
type: task
status: done
created: 2026-05-20
updated: 2026-05-20
completed: 2026-05-20 16:47
---

# Observability module

## Why

stitchkit today ships only the low-level hooks — `LifecycleHooks` (`afterHandle`
/ `onError`) and `ToolCallHooks` (`beforeToolCall` / `afterToolCall`). Every
consuming project then re-builds the **same audit layer** on top of them: a sink,
an HTTP audit wrapper, a request-context, a source enum, a payload sanitiser, a
trace id.

Across three sibling projects this layer is duplicated, divergent, or missing:

- one has a good one,
- one has a different good one (literally copy-pasted from the third),
- one has no audit at all.

stitchkit should own the reusable audit machinery. A project's logging should
then be just **a table + a `write(event)` function** — nothing else.

## Current state — three projects

| Piece | gecko-gen (stitchkit) | gecko-chat (Hono) | capetownian (Hono) |
|-------|----------------------|-------------------|--------------------|
| Trace / correlation | basic `x-request-id` | **W3C `traceparent`** + `spanId` / `parentSpanId`, span chaining | W3C `traceparent` (but logger ignores it) |
| Request-context ALS | **`RequestContext` ALS** | none — context threaded by hand | none |
| Audit event | `RequestLog` — flat | `ActivityLog` — **richer**: spans, `resultSize` / `responseBytes`, `entityId`, `service` / `action`, + Socket.IO live stream | **none** |
| Sanitisation | `sanitizePayload` | **`redact` + `buildPreview` + `measureOutput`** | none — raw args logged |
| Hook wiring | stitchkit `afterToolCall` + `withRequestAudit` | `executeToolMethod` chokepoint + `writeAudit` | console only |
| Logger | pino | hand-rolled coloured | pino + coloured + JSONL |

**Best of breed:**
- Trace → gecko-chat (proper W3C, span chaining).
- ALS context → gecko-gen (no ALS = manual threading = error-prone).
- Audit event richness → gecko-chat (`ActivityLog`).
- Sanitisation → gecko-chat (redact + preview + measure).
- Hook model → stitchkit.

The contract→transport framework itself is copy-pasted between gecko-chat and
capetownian (capetownian's `utils.ts` says *"Copied from gecko-chat-bot"*).
stitchkit ends that — and should end the duplicated audit layer too.

## What stitchkit should own

A built-in observability module, one level above the raw hooks:

**A. W3C Trace Context.** `traceparent` parse / generate, `{ traceId, spanId,
parentSpanId }`, child-span chaining (each tool call a child span). stitchkit
today has only a basic `resolveTraceId` / `generateTraceId` — upgrade to the
real W3C standard.

**B. `RequestContext` ALS.** `runWithRequestContext` / `getRequestContext` over
an `AsyncLocalStorage` — carries trace ids, `source`, identity, `startedAt`,
client info. Removes the manual context threading that non-ALS projects suffer.
stitchkit already has `getClientInfo` — extend.

**C. `RequestEvent` — a normalised audit event.** One uniform shape produced by
both hook families: `source`, `method` / `path` / `toolName`, trace ids,
`statusCode`, `durationMs`, `error`, sanitised `payload` preview,
`resultSize` / `responseBytes`, identity.

**D. Sanitisation utilities.** `redact` (strip secret-named keys),
`truncatePreview` (cap payload size), `measureSize` (response bytes).

**E. `createAuditHook({ write })`.** Wires `afterHandle` + `afterToolCall` +
`onError`, runs them inside the ALS, normalises every call into a `RequestEvent`,
and calls the project's `write(event)`. The project supplies **only** the sink.

**F. (optional) dev tool-call console formatter.** The coloured
`<-- tool {args}` / `--> tool ✓ {ms}` output — hand-rolled in two of the three
projects. A built-in dev default.

## What stitchkit should NOT own

- The audit DB table — project-specific (Prisma model).
- The logger backend — pino vs console is the project's choice. stitchkit keeps
  the `StitchLogger` interface only.
- Project-domain sources (e.g. `FLOW` / `TELEGRAM` / `SYSTEM`) — stitchkit owns
  the transport sources `http` / `mcp` / `agent`; the project extends.
- Live-stream emit (Socket.IO `activityCreated`) — a project add-on.
- The audit-query / admin UI — built on the project's own table.

## Plan

### Phase 1 — stitchkit observability module
1. W3C trace context — `traceparent` parse / generate, span chaining.
2. `RequestContext` ALS — `runWithRequestContext` / `getRequestContext`.
3. `RequestEvent` — the normalised event type.
4. Sanitisation — `redact` / `truncatePreview` / `measureSize`.
5. `createAuditHook({ write, redact? })` — wires both hook families + ALS,
   normalises, calls `write`.
6. (optional) dev tool-call console formatter.
7. Docs — extend `docs/guide/observability.md`; CHANGELOG entry.

### Phase 2 — gecko-gen adopts
Replace `withRequestAudit` + the `RequestContext` ALS + `sanitizePayload` + the
hand-wired `afterToolCall` with stitchkit's `createAuditHook`. `writeRequestLog`
+ the `RequestLog` table stay — they are the sink.

### Phase 3 — gecko-chat / capetownian (on stitchkit)
Once migrated to stitchkit they get audit by supplying a table + a `write`
function. No re-implementation. capetownian gains audit it currently lacks
entirely.

## Open questions

- **Placement** — a new entrypoint `stitchkit/observability`, or fold into
  `stitchkit/server`? The ALS + hooks are server-side.
- **`RequestEvent` shape** — start from gecko-chat's `ActivityLog` field set
  (richest), drop project-specific columns.
- **`createAuditHook`** — after-only, or also a start event from
  `beforeToolCall` / `onRequest`? After-only matches "log a completed call".
- **W3C scope** — full `traceparent` + `tracestate`, or `traceparent` only.
- The `afterToolCall` signature already carries `args` + `context` — the audit
  hook builds directly on that.

## References

- Hooks: `ToolCallHooks` (`tools/execute.ts`), `LifecycleHooks` (`server/types.ts`).
- Existing partials: `generateTraceId` / `resolveTraceId` / `getClientInfo` (`server/request`), `StitchLogger`, `paginatedSchema`.
- Guide: `docs/guide/observability.md`.
- gecko-gen: `RequestLog`, `writeRequestLog`, `withRequestAudit`, `RequestContext` ALS, `sanitizePayload`.
- gecko-chat: `ActivityLog`, `logMutation`, `middleware/trace-context.ts`, audit-service `redact` / `buildPreview` / `measureOutput`.
- capetownian: no audit layer — the gap this module fills.

## What was done

Phase 1 (stitchkit module) and Phase 2 (gecko-gen adopts) shipped. Phase 3
stays open — blocked on gecko-chat / capetownian migrating to stitchkit.

### stitchkit — observability module (new entrypoint `stitchkit/observability`)

- [x] `packages/core/src/observability/trace.ts` — W3C trace context:
  `TraceContext`, `parseTraceparent` / `formatTraceparent` /
  `resolveTraceContext` / `createTraceContext` / `childSpan`.
- [x] `packages/core/src/observability/context.ts` — `RequestContext` over
  `AsyncLocalStorage`: `runWithRequestContext` / `getRequestContext` /
  `getTraceId` / `getUserId` / `setRequestUser` / `setRequestError` /
  `wrapInRequestContext`.
- [x] `packages/core/src/observability/sanitize.ts` — `redact` /
  `truncatePreview` / `sanitizePayload` / `measureSize`, `JsonValue` type.
- [x] `packages/core/src/observability/event.ts` — `RequestEvent`.
- [x] `packages/core/src/observability/audit.ts` — `createAuditHook({ write,
  filter?, sanitize? })` → `{ http, toolCall }`. HTTP audit is a fetch-handler
  wrapper (sees the final response, no `onError` contention); tool-call audit
  is the `afterToolCall` hook.
- [x] `packages/core/src/observability/index.ts` — entrypoint barrel.
- [x] `packages/core/package.json` — `./observability` export + `build:js` entry.
- [x] `packages/core/tests/execute.test.ts` — two hook tests realigned to the
  current `afterToolCall(toolName, args, result, durationMs, context)` signature.

### stitchkit — docs

- [x] `docs/guide/observability.md` — rewritten: module first, raw hooks the
  escape hatch.
- [x] `docs/api/reference.md` — `## stitchkit/observability` section.
- [x] `CHANGELOG.md` — `[Unreleased] → ### Observability`.
- [x] `docs/DECISIONS.md` — ADR 0012.

### gecko-gen — Phase 2 adoption

- [x] Deleted `lib/requestContext.ts` and `services/audit/sanitize.ts` —
  replaced by the module.
- [x] `services/audit/requestAudit.ts` — `audit = createAuditHook(...)`; the
  `write` sink maps `RequestEvent` → `RequestLog` (`requestId` = `traceId` for
  HTTP, `spanId` for tool calls).
- [x] `mcp/server.ts` — `afterToolCall` keeps the pino `[MCP]` line and
  delegates the row to `audit.toolCall`.
- [x] `index.ts` — `fetch: wrapInRequestContext(audit.http(handleRequest))`.
- [x] `transport/server.ts` — `traceId: getTraceId`; `hooks/auth.ts` —
  `setRequestUser`; `hooks/error.ts` — `getTraceId`, `setRequestHttpStatus`
  dropped; `lib/logger.ts` — `ctx.trace.traceId`.
- [x] `bun check` green across db / shared / mcp / frontend / backend.

### What was NOT done

- **Dev tool-call console formatter (item F).** Dropped — optional, zero
  consumers, duplicated `server/logger.ts` formatting. Revisit only with a real
  consumer, extracting shared formatters first.
- **Phase 3 — gecko-chat / capetownian.** Blocked: neither is on stitchkit yet.
- **Runtime verification.** Type-checked and built; the gecko-gen services were
  not restarted.

### Code links

- stitchkit module: `packages/core/src/observability/` (6 files).
- gecko-gen sink: `packages/backend/src/services/audit/requestAudit.ts`.
- ADR: `docs/DECISIONS.md` → ADR 0012.
