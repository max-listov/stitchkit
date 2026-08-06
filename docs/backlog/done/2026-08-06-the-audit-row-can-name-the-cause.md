---
title: "The audit row can name the cause of a tool failure"
description: afterToolCall builds the row but only sees the scrubbed envelope, while onToolError holds the real cause — so createAuditHook writes 'Internal server error' and consumers correlate the two hooks by hand through a WeakMap.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 12:44 +07:00
related: docs/decisions/0042-the-audit-row-may-name-the-cause.md
---

# The audit row can name the cause of a tool failure

0.30.0 made the cause of a tool failure **observable** (`onToolError`, → ADR
0041). It did not make it **recordable**: the hook that holds the raw value and
the hook that builds the audit row are different hooks, and nothing joins them.

## Why this is a real gap, not tidying

The two transports are not symmetric, and the asymmetry is in `audit.ts`:

| Row | Where its `errorCode` / `errorMessage` / `errorDetail` come from |
|---|---|
| HTTP (`audit.ts:108`) | `ctx.error` — whatever the consumer curated with `setRequestError`, typically from the raw error `hooks.onError` handed them |
| Tool (`audit.ts:152`) | `result` — the scrubbed envelope, and nothing else |

So on HTTP a project records why a request failed. On a tool call the same
project records `INTERNAL_SERVER_ERROR` / `Internal server error` — the row
exists, it is just useless for the one question it is consulted for. ADR 0030
("complete error-code logging") is true on one path and hollow on the other.

A consuming project already hit this and worked around it exactly as the shape
forces: a `WeakMap` keyed on the call's context object, written in `onToolError`,
read in `afterToolCall`. That workaround is correct — every mount does build one
fresh context per call and hands the same reference to both hooks — but a
framework that makes each consumer re-derive the join is the defect.

## Decision

`afterToolCall` gains a **seventh parameter**, the raw thrown value:

```ts
afterToolCall?: (
  toolName, args, result, durationMs, context, endpoint,
  error?: unknown,          // ← present only when the call failed by throwing
) => void | Promise<void>
```

Additive, not breaking: a six-parameter function stays assignable, so every
existing hook — including `createToolLogger` — keeps compiling untouched.

`createAuditHook` then uses it, and this is the part that needs a rule rather
than a shrug, because writing a raw message into a sink by default is exactly
what the scrubbing exists to prevent:

- **`errorMessage` takes the raw message only where the envelope was scrubbed** —
  `code === 'INTERNAL_SERVER_ERROR'` with a raw error present. That is precisely
  the case where the current value carries no information. A thrown `AppError`
  or a `ZodError` already produces a truthful message and keeps it.
- **`errorCode` and `errorDetail` are untouched.** The code is the stable
  contract; the detail stays whatever the result carried, still sanitised.
- **The stack is not written.** It belongs in an error tracker, not in every
  audit row; `onToolError` hands it to whoever wants it.

This keeps the framework's promise (a raw message never reaches the *caller*)
while letting the project's own server-side record say what happened — the same
bargain the HTTP row has always had.

## Acceptance

- [x] `ToolCallHooks.afterToolCall` takes `error?: unknown`, documented as
      present only for a throw
- [x] `executeToolMethod` passes it from the `catch` path, and only from there —
      `finish(result, thrown?)` takes it as a second argument, and every other
      exit calls `finish` with one
- [x] `createAuditHook` writes the raw message into `errorMessage` only when the
      envelope was scrubbed to `INTERNAL_SERVER_ERROR` (`auditErrorMessage`)
- [x] A six-parameter `afterToolCall` still compiles and still fires (pinned by a
      test, not by assumption)
- [x] Tests: the value reaches `afterToolCall` by identity; absent on success and
      on both non-throw failures; the audit row names the cause for an unexpected
      throw; the audit row is unchanged for a thrown `AppError`
- [x] `docs/guide/observability.md` — the `WeakMap` correlation section is
      replaced by the parameter (removed, not kept as an alternative)
- [x] `docs/api/reference.md` + `CHANGELOG.md`
- [x] ADR 0042 — the recording rule, plus the line it draws: a raw message may
      reach the project's own record, never the caller

## Что сделано

**Ядро**

- [x] `packages/core/src/tools/execute.ts` — `afterToolCall` gains
      `error?: unknown`; `finish` takes the thrown value as a second argument and
      only the `catch` path supplies it
- [x] `packages/core/src/observability/audit.ts` — `auditErrorMessage(result,
      thrown)`: the raw message wins only over the scrubbed
      `INTERNAL_SERVER_ERROR` placeholder; every other envelope keeps its own
      message, `errorCode` / `errorDetail` untouched, stack never written

**Тесты** — 758 → 765. Three cases in `tool-error-hook.test.ts` (identity of the
value beside the scrubbed result; `undefined` across all four non-throw exits;
a six-parameter hook still compiles and fires) and four in
`audit-tool-event.test.ts` (scrubbed row gains the real message; a thrown string
is taken as the message; a truthful `AppError` envelope is left alone; no raw
error means the row is byte-for-byte what it was).

**Документация**

- [x] ADR 0042 + row in the index
- [x] `docs/guide/observability.md` — new section "One row that names the cause";
      the `WeakMap` recipe is gone and the `setRequestError` warning now says
      plainly which record each hook fills; the raw-hooks paragraph carries the
      full signature
- [x] `docs/api/reference.md`, `CHANGELOG.md`

## Не делалось

- [x] Converting the tool hooks to a single options object — `afterToolCall` is
      now at seven positional parameters and that is the obvious next cleanup,
      but it breaks every consumer's hook and deserves its own decision rather
      than riding along with a field. Recorded in ADR 0042's consequences
- [x] Writing the stack into the audit row — rejected in ADR 0042: it belongs in
      a tracker, and `onToolError` hands it to anyone who wants it
