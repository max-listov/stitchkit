---
title: "ADR 0042 — The audit row may name the cause, the caller may not"
type: decision
status: accepted
created: 2026-08-06
updated: 2026-08-06
---

# ADR 0042 — The audit row may name the cause, the caller may not

- **Status:** Accepted — completes [ADR 0041](0041-tool-error-cause-is-observable.md)
  and makes [ADR 0030](0030-audit-verb-and-json-error-details.md)'s "complete
  error logging" true on the tool path
- **Date:** 2026-08-06

## Context

ADR 0041 made the cause of a tool failure **observable** through `onToolError`.
It did not make it **recordable**. The hook that holds the raw value and the hook
that builds the audit row are different hooks, and nothing joined them, so
`createAuditHook` kept writing `INTERNAL_SERVER_ERROR` / "Internal server error"
into the row — present, and useless for the only question the row is consulted
for.

The two transports were not symmetric, and the asymmetry sat in `audit.ts`:

| Row | Source of `errorCode` / `errorMessage` / `errorDetail` |
|---|---|
| HTTP | `ctx.error` — what the project curated with `setRequestError`, typically from the raw error `hooks.onError` handed it |
| Tool | `result` — the scrubbed envelope, and nothing else |

A consuming project hit this immediately and worked around it the only way the
shape allowed: a `WeakMap` keyed on the call's context object, written in
`onToolError`, read in `afterToolCall`. The workaround is sound — every mount
builds one fresh context per call and hands the same reference to both hooks —
but a framework that makes each consumer re-derive that join is the defect.

## Decision

**`afterToolCall` receives the raw thrown value as a seventh parameter.**
Additive: a six-parameter hook stays assignable and keeps compiling, so nothing
in the wild breaks. Present only on the throw path — an argument-validation
failure, an output-schema mismatch and a `beforeToolCall` rejection leave it
`undefined`, because none of them ever had a raw value to lose.

**`createAuditHook` writes the raw message into `errorMessage` only where the
envelope was scrubbed** — `code === 'INTERNAL_SERVER_ERROR'` with a raw error
present. Everywhere else the envelope's message is already truthful (a thrown
`AppError`, a `ZodError`) and it is also what the caller was told, so the row and
the response agree.

`errorCode` and `errorDetail` are untouched: the code is the stable contract, the
detail stays whatever the result carried and stays sanitised. The **stack is not
written** — it belongs in an error tracker, not in every row of an audit table;
`onToolError` hands it to whoever wants it.

### Why writing a raw message here is not a leak

The scrubbing in `normalizeError` protects the **caller**: a tool result is read
by a model and often relayed to a user, and a raw `Error.message` can carry a
connection string or a file path. That protection is unchanged — the envelope the
caller receives is still generic.

The audit row is a different audience: a server-side record, written to a sink
the project chose, read by the project's own operators. The HTTP row has had
exactly this property since the beginning (`ctx.error.message` is whatever the
project curated, usually the raw message). Extending it to the tool row removes
an inconsistency rather than creating an exposure.

The line to hold is therefore not "the framework never handles a raw message" but
**"a raw message never crosses to the caller"** — and that line is now stated
where it can be checked, instead of being an accident of which hook happened to
see what.

## Consequences

- `createAuditHook` records why a tool call failed. ADR 0030 is now true on both
  transports rather than one.
- The `WeakMap` correlation is obsolete; the guide teaches the parameter instead,
  and the workaround is removed rather than left as an alternative — two ways to
  reach one value is how the next reader ends up doing the harder one.
- A project that wants the stack, or wants to route the cause elsewhere entirely,
  still has `onToolError`. The two hooks now differ by purpose, not by capability:
  `onToolError` is for a sink of your own, `afterToolCall` is for the record.
- Anything further that a tool row might want (the handler output, say) will hit
  the same parameter-count pressure — `afterToolCall` is now at seven positional
  parameters. Converting the tool hooks to a single options object is the obvious
  next step and is deliberately **not** taken here: it is a breaking change to
  every consumer's hook, and it should be one decision made on its own merits,
  not a side effect of adding a field.
