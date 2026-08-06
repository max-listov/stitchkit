---
title: "The HTTP audit row names its cause too"
description: 0.32.0 taught the tool row to record why a call failed and left the HTTP row needing hand-wiring — the same asymmetry as before, now pointing the other way, and created by the fix.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 13:58 +07:00
related: docs/decisions/0043-the-framework-records-the-failure.md
---

# The HTTP audit row names its cause too

## The evidence

Before 0.32.0 the HTTP row could name the cause of a failure and the tool row
could not (→ ADR 0042). 0.32.0 fixed the tool row. Checked what that left, and
the perch has simply moved:

`packages/core/src/server/create.ts` calls `setRequestEndpoint` and **never**
`setRequestError`. The framework fills the request context with the endpoint
identity by itself — the guide advertises exactly that, "nothing to wire" — but
leaves the error fields empty. So today:

| Row | Names the cause |
|---|---|
| Tool | yes, by itself since 0.32.0 |
| HTTP | only if the project writes an `onError` hook **and** remembers to call `setRequestError` inside it |

A project that wires `createAuditHook` and nothing else now gets richer records
from its MCP tools than from its HTTP API. That is not a defensible place to
stop, and it was created by the previous fix rather than found — worth saying
plainly.

There is a second, quieter hole in the same place. `respondError` has two
branches: a custom `hooks.onError` that returns its own `Response`, and the
framework default. A project that customises the envelope and forgets
`setRequestError` gets an empty error on **every** audited failure, and nothing
tells it so.

## Decision

`respondError` records the failure on the request context itself, in the one
place both branches pass through. It holds the raw `err` on both, so this is a
single insertion, not a refactor.

**Precedence: the framework writes first, the project overwrites.** `onError`
runs before the framework's own write today, so the order has to be deliberate —
a project that curates `setRequestError` must win, and a project that does
nothing must still get a row. Write the framework's value only when the context
carries no error yet.

**The message follows ADR 0042's rule, unchanged.** The raw message goes in only
where normalisation scrubbed the envelope to `INTERNAL_SERVER_ERROR`; a thrown
`AppError` or a `ZodError` keeps its own. One rule, both transports — which is
the whole point, and it means ADR 0042 gains a second consequence rather than a
sequel.

**The response is untouched.** This writes to a server-side record. The envelope
the caller receives stays exactly as it is on both branches.

## Watch: the log line reads the same context — checked, no effect

The worry was that filling `ctx.error` would silently change the **access log**,
which people scrape, and not only the audit row.

Read the code instead of guessing: `collectExtraLogFields` takes `userId`,
`serviceName`, `action` and `dimensions` from the context and **never**
`ctx.error`. The completion line gets its code from `logDone`, as before. So the
change is invisible to the log line, no CHANGELOG note about log output is owed,
and the split is worth keeping deliberately — an audit row is a record the
project keeps, an access log is often shipped elsewhere. Recorded in ADR 0043.

## Acceptance

- [x] `respondError` writes `{ code, message, details }` to the request context
      on both branches — the custom-`onError` one and the framework default
- [x] A project's own `setRequestError` still wins; the framework only fills what
      is empty
- [x] The raw message is used only where the envelope was scrubbed to
      `INTERNAL_SERVER_ERROR` — extracted as `recordedErrorMessage` in
      `internal/errors.ts` and now called by **both** paths, so the rule exists
      once rather than twice
- [x] The response body and status are byte-identical on both branches — pinned
      by a test
- [x] The effect on the structured log line is decided, tested and written down —
      there is none, see above
- [x] Tests: `packages/core/tests/http-audit-cause.test.ts`, 8 cases
- [x] `docs/guide/observability.md` — rewritten: the failure is recorded for you,
      `setRequestError` is an override
- [x] `CHANGELOG.md` + **ADR 0043** — the precedence rule and the
      no-new-stderr constraint did need their own argument

## Что сделано

**Ядро**

- [x] `internal/errors.ts` — `recordedErrorMessage(code, envelopeMessage, thrown)`:
      the shared expression of ADR 0042's rule
- [x] `observability/audit.ts` — `auditErrorMessage` is now a thin wrapper over it
- [x] `server/create.ts` — `recordFailure()` inside `respondError`, called on the
      custom-`onError` branch and on the framework default

**The trap avoided.** `normalizeError` logs the raw cause, and the custom-`onError`
branch deliberately never calls it — recording naively would have added a stderr
line to every project that customises its envelope. `recordFailure` takes an
already-normalised error only from the branch that computed one, and otherwise
uses the side-effect-free `AppError.is` / `errorCode`. Pinned by a test that
asserts the branch stays silent.

**Тесты** — 765 → 773. Cause named with no `onError` at all · a thrown `AppError`
keeps its own message · a custom `onError` returning its own `Response` still
produces a named row · a project's `setRequestError` wins · a success records no
error · the default envelope is byte-identical · the custom branch gains no
stderr line.

**Документация** — ADR 0043 + index row, `docs/guide/observability.md`,
`CHANGELOG.md`.

## Не делалось

- [x] Putting the cause on the access log line — it does not read `ctx.error`
      today, and giving it one is a separate choice with its own trade-off
      (audit rows stay put, access logs get shipped). Argued in ADR 0043
