---
title: "A thrown tool error loses its cause before any consumer hook sees it"
description: On the tool path an unexpected throw is normalised to a bare INTERNAL_SERVER_ERROR and the real cause goes only to the framework's own console.error — the HTTP path hands the raw error to onError, the tool path hands nobody anything.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 12:24 +07:00
related: docs/decisions/0041-tool-error-cause-is-observable.md
---

# A thrown tool error loses its cause before any consumer hook sees it

Reported by an agent on a consuming project. Verified against the source before
writing this — the report is accurate, and the gap is narrower and sharper than
"there is no error hook".

## What is actually missing

`ToolCallHooks.afterToolCall` already fires for every failure and carries the
`ToolResult`. So for a **mapped** failure — an `AppError` thrown by an auth gate
or by the handler — the consumer already has `code` and `details` and can route
them anywhere, including `setRequestError` (the request's `AsyncLocalStorage`
store is live inside `executeToolMethod`, so the value reaches the HTTP log line
for the MCP request). Those cases are not broken.

The hole is the **unexpected** throw — a DB timeout, a `TypeError`, the case you
actually go to the logs for. `executeToolMethod` catches it and calls
`toolResultFromError` → `normalizeError`, which for a non-`AppError`, non-`ZodError`
value does this (`internal/errors.ts:71`):

```ts
console.error('[stitchkit] unhandled error:', err);
return new AppError('INTERNAL_SERVER_ERROR', 'Internal server error', 500);
```

The scrubbing is right — a raw `Error.message` can carry a connection string.
What is wrong is that the scrubbed value is the **only** thing any consumer hook
ever sees. `afterToolCall` receives `{ ok: false, code: 'INTERNAL_SERVER_ERROR',
details: { message: 'Internal server error' } }` — no cause, no stack, no
`cause` chain. The real value exists for exactly one statement and leaves through
a `console.error` the consumer cannot route, filter or correlate.

The HTTP path has no such hole: `hooks.onError(ctx, error, endpoint)` receives
the value **as thrown**, before normalisation. Same framework, same handler, two
different answers to "why did it fail" depending on which transport called it.

## Shape

Not on `ToolLifecycle`, and this is the part worth arguing.

`ToolLifecycle` documents that a `createServer({ hooks })` object is assignable
to it — that is why `createAuthHook`'s result drops straight in as
`beforeHandle`. Adding `onError` there forces a choice between two bad ends,
both probed:

- **Reuse the HTTP signature** (`=> Response | Promise<Response> | undefined`)
  and ignore the return on the tool path. Assignability survives; a consumer's
  shared `onError` silently stops producing its envelope on one of two
  transports. A returned value that is quietly dropped is a trap.
- **Type it `=> void | Promise<void>`.** Honest, but it *breaks* the assignment —
  verified with `tsc`: the void-return bivariance rule does not apply to a
  `void | Promise<void>` union target, so `LifecycleHooks` stops being assignable
  to `ToolLifecycle` and every consumer passing a shared hooks object fails to
  compile.

So put it where observation already lives — `ToolCallHooks`, next to
`beforeToolCall` / `afterToolCall`. No shared-object constraint, no meaningless
`Response`, and it sits with the hooks a project already passes for audit:

```ts
/**
 * The handler path threw — the value **as thrown**, before it is normalised
 * into a `ToolResult`. The tool envelope is not negotiable here; this is
 * observation, so the return value is ignored.
 */
onToolError?: (
  toolName: string,
  error: unknown,
  context: ToolCallContext,
  endpoint: MethodDef,
) => void | Promise<void>;
```

## When it fires

Only for a throw from inside the handler path — `lifecycle.beforeHandle`, the
handler, `lifecycle.afterHandle`. That is exactly the set where information is
destroyed.

It deliberately does **not** fire for:

- `beforeToolCall` throwing — already returned verbatim as an `AppError` result;
- params / input validation — a `safeParse` failure, not a throw, and the
  formatted message is already in the `ToolResult`;
- output-schema mismatch — likewise fully described in the result.

Every one of those is legible in what `afterToolCall` receives, so firing there
too would add a second path to the same information and invite double-logging.

## Acceptance

- [x] `onToolError` on `ToolCallHooks`, fired inside the `catch` in
      `executeToolMethod`, **before** `toolResultFromError`, with the value as
      thrown
- [x] The hook is guarded — its own throw is reported and swallowed, never
      replaces the original failure, and `afterToolCall` still fires
- [x] Fires once per call; `afterToolCall` continues to fire after it
- [x] Reaches every tool mount that already accepts `hooks` — `mountMcp`,
      `createMcpHandler`, `mountAgent`, `createCli` (all four go through
      `createToolRunner`, so the field needed no plumbing; proved end-to-end
      through `mountAgent`)
- [x] Tests: raw value identity (same object reference as thrown, stack intact);
      not fired for a validation failure; not fired for a `beforeToolCall`
      rejection; a throwing `onToolError` does not change the returned
      `ToolResult`; ordering against `afterToolCall`
- [x] `docs/guide/observability.md` — the raw-hooks table gains the row, and the
      HTTP/tool asymmetry is stated instead of implied
- [x] `docs/api/reference.md` — `ToolCallHooks` updated
- [x] `CHANGELOG.md` under `[Unreleased]` — additive, no breaking section
- [x] ADR written after all — the placement argument is exactly what will be
      re-litigated (it was already asked for the other way round): ADR 0041

## Open question for review — resolved

Whether `normalizeError`'s `console.error` should stay once a consumer can route
the cause properly.

- [x] **Keeps it.** The HTTP path has had this property since the beginning —
      `hooks.onError` receives the value *and* the console write fires — so
      removing it on the tool side would break the symmetry this task exists to
      restore. A duplicate in a wired project is cheaper than a silence in every
      unwired one. Recorded in ADR 0041.

## Что сделано

**Ядро**

- [x] `packages/core/src/tools/execute.ts` — `ToolCallHooks.onToolError`, fired
      in the `catch` before `toolResultFromError`, guarded and awaited ahead of
      `afterToolCall`
- [x] `ToolLifecycle`'s doc comment now states why there is deliberately no
      `onError` twin there, and points at `onToolError`
- [x] No plumbing needed — `mountMcp` / `createMcpHandler` / `mountAgent` /
      `createCli` all pass the whole `hooks` object through `createToolRunner`.
      The two mount configs whose JSDoc enumerated the hooks (`mcp.ts`,
      `cli.ts`) were updated so the enumeration stays true

**Тесты** — `packages/core/tests/tool-error-hook.test.ts`, 16 cases in four
groups: the value as thrown (object identity, `stack`, `cause`, a non-`Error`
throw, an `AppError`, tool name / context / endpoint identity) · the span it
covers (`beforeHandle`, `afterHandle`, and the four cases it must *not* fire
for) · non-interference (ordering against `afterToolCall`, an awaited async
hook, a throwing hook, a rejecting hook) · reaching a real mount via
`mountAgent`. Suite 742 → 758, gate green.

**Документация**

- [x] ADR 0041 + row in the index
- [x] `docs/guide/observability.md` — new row in the raw-hooks table and a
      section "The cause behind a failed tool call": what `afterToolCall` does
      and does not give, the `setRequestError` example, the firing boundary, and
      why the hook is not on `ToolLifecycle`
- [x] `docs/api/reference.md` — `ToolCallHooks` row
- [x] `CHANGELOG.md` `[Unreleased]` → Added, additive

## Не делалось

- [x] A hook that can *shape* a tool error (the envelope stays the framework's)
      — deliberately not conflated with observation; if it is ever wanted it is
      a separate decision, noted in ADR 0041
- [x] Release — the change sits in `[Unreleased]` awaiting the owner's call on
      when to cut it
