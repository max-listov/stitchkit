---
title: Pre-npm deduplication cleanup
description: Remove internal code duplication across stitchkit before the npm release — one blocking duplicated public type plus a set of copy-pasted internals
type: task
status: done
created: 2026-05-20
updated: 2026-05-20
completed: 2026-05-20 16:47
related: docs/backlog/done/2026-05-20-observability-module.md
---

# Pre-npm deduplication cleanup

## Why

With an npm release imminent, a duplication audit (8 parallel passes over the
`packages/core` tree) found one release-blocking defect — a duplicated public
type — plus a cluster of copy-pasted internals. Behaviour-preserving cleanup,
no API behaviour change.

## What was done

### Blocker

- [x] `ToolExtend` was declared byte-identically in `tools/mcp.ts` and
  `tools/agent.ts` and re-exported under two public names
  (`McpToolExtend` / `AgentToolExtend`). Now one interface in `tools/mount.ts`,
  exported once as `ToolExtend`.

### High

- [x] `tools/mount.ts` — new shared module. `mountMcp` / `mountAgent` walked a
  service's methods and ran tool calls with near-identical code; both now use
  `collectTools` (method walk + schema merge + extend) and `createToolRunner`
  (extend resolve + arg strip + execute). `formatToolError` shares the error
  branch of `formatMcpResult` / `formatAgentResult`.
- [x] `browser/http.ts` — `parseApiErrorBody` extracted (was a closure
  `defaultParseError` plus a byte-identical `parseApiError` in `client.ts`).
- [x] `browser/client.ts` — `throwForErrorResponse` extracted; the two
  near-identical `!res.ok` blocks (multipart / normal) collapse to one call.
- [x] `server/router.ts` — `matchSegments` extracted; the three segment-match
  loops (`matchRoute` / `allowedMethods` / `matchRawRoute`) collapse to it.

### Med

- [x] `ErrorEnvelope` — one exported error-response type in `contract/errors.ts`,
  the single name for the error shape; `AppError.toJSON()` and the typed HTTP
  client are declared against it. The former `ApiErrorBody` type — a pure alias
  of `ErrorEnvelope` — was removed.
- [x] `isRecord` — one guard in `internal/typed.ts`, replacing the copy in
  `tools/mcp.ts` and ad-hoc inline object checks in `tools/remote.ts`,
  `browser/http.ts`, `observability/audit.ts`, `observability/sanitize.ts`.
- [x] `server/swept-map.ts` — `createSweptMap` extracted; `createCache` and
  `createRateLimiter` shared a copy-pasted sweep-timer scaffold.
- [x] `server/logger.ts` — `levelForStatus`, `buildLogFields` extracted and
  `elapsedMs` exported; the structured completed-request log line was built
  twice (`create.ts` vs `logger.ts`).

### Deliberately not done

- **`InferInput` "divergence"** (flagged by the audit as a latent bug) — not a
  bug. `contract/define.ts` `InferInput` (`z.input` — pre-parse, for the typed
  client) and `server/types.ts` `InferInput` (output type — for the handler's
  `ctx.input`) are two correct, documented helpers that happen to share a name
  in separate file scopes. They cannot be merged — they compute different
  types. Left as-is.
- **A shared `ClientInfo` type** for `ipAddress?` / `userAgent?` — two optional
  fields; a shared type would force `contract/define.ts` to import from
  `server/`, inverting the layer dependency. Over-engineering; left as-is.

### Verification

- `bun run check`, `bun test` (143 pass), `bun run build` — all green.
- A consuming app's `bun check` green against the rebuilt stitchkit (no consumer
  used the removed `McpToolExtend` / `AgentToolExtend`).

### Code links

- `packages/core/src/tools/mount.ts`, `server/swept-map.ts` — new shared modules.
- `packages/core/src/internal/typed.ts` — `isRecord`.
- `packages/core/src/contract/errors.ts` — `ErrorEnvelope`.
