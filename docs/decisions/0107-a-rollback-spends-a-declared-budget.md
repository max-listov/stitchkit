---
title: "ADR 0107: A rollback spends a declared budget, and the budget is a bound"
description: "The rollback of a failed startup had no call site to be given deadlines by, so it gave itself none and every derived budget came out zero; the budget is now declared on the application, applies to both stopping paths, and is enforced rather than merely handed out."
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0107 — A rollback spends a declared budget, and the budget is a bound

## Context

ADR 0102 lists the kernel's obligations as separate bullets: *"rollback of every
resource whose start was attempted"* and *"bounded drain, reverse-order close
and optional force under two absolute process-wide deadlines"*. The deadlines
belong to the phase list of `shutdown()`. Nothing said what a **rollback**
spends, and the gap was not noticed because it does not look like a gap: the
rollback calls `close`, `close` takes a context, and the context type declares
both deadlines optional.

Optional turned out to mean two different things at the two ends. The kernel
read it as "this path has no deadlines to give". `managedServerResource` read
it as `context.deadlineAt ?? now`, and then computed `now - now` — which is to
say it answered "your budget is zero". So a failed startup handed its server
`{ gracePeriodMs: 0, forceTimeoutMs: 0 }`, and three things followed:

- requests the server had already accepted died at the socket, unanswered;
- the rollback itself failed, because `withTimeout(forceStop(), 0)` cannot
  succeed;
- and that failure **replaced the diagnosis**. `start()` rejected with an
  `AggregateError` reading *"application startup and rollback failed"*, so the
  first line an operator read was shutdown machinery and the resource that
  actually broke was one entry down.

Measured, with one request in flight: the request was severed in 39ms and the
startup cause was buried. The path became ordinary rather than rare when
`reportHealth` during `start` began to be honoured — a required resource that
starts unhealthy now fails the startup, so rollback is a normal outcome.

There is a second defect underneath, and it predates all of this: the rollback
loop awaited each `close` with nothing watching the clock. Every other phase in
`shutdown()` is wrapped in `untilDeadline`. A resource whose `close` never
returns — a poller awaiting its own completion, a consumer resource with a hung
upstream — therefore kept a failed startup from **ever** reporting why it
failed. Handing that loop deadlines without watching them would have moved the
hang from "forever" to "forever" while reading as though it were fixed.

## Decision

**The budget is declared on the application.** `ApplicationConfig.shutdown`
(`ApplicationShutdownBudgetSchema`: `gracePeriodMs`, `forceTimeoutMs`, no
signal) is the budget the rollback spends, and the default for `shutdown()`
called with no options. A rollback happens inside `start()`, so there is no call
for a caller to pass options to; the budget has to live where the application
does. Making it also the `shutdown()` default keeps "how long may this
application take to stop" one number instead of two that can disagree.

**The budget is enforced.** The rollback's `close` sweep runs under a timer at
the force deadline. A `close` that does not finish is abandoned, reported as a
`close` failure, and the startup error remains the `AggregateError`'s `cause`.

**An absent deadline is not a spent one.** `managedServerResource` no longer
collapses absence into `now`. It omits the field and lets
`ShutdownOptionsSchema` — which already carries `.default(30_000)` /
`.default(5_000)` — apply its own defaults. This is the Zod-first rule applied
to a boundary: the schema owns these numbers, and a second copy in an adapter is
a copy that can drift. It also fixes the class of bug rather than one arrangement
of it, since a consumer or the conformance kit may legitimately build a context
with no deadlines.

## Consequences

**A failed `start()` can now take up to the budget to reject.** This is the
trade, and it is the reason this is an ADR and a `### ⚠️ Breaking changes`
entry rather than a bug fix. With nothing in flight the rollback still returns
at once — a grace period is a ceiling, not a sleep. With a request that never
finishes, the default 30s+5s turns a rejection that took milliseconds into one
that can take 35 seconds. An application that would rather fail fast declares a
smaller budget; that knob is why the ceiling is not a supervisor policy chosen
by the kernel, which ADR 0102 says it does not choose.

It is also what makes the bound testable. A bound that can only be exercised by
waiting out the default budget is a bound nobody can afford to test, and an
untested bound is not one anybody should rely on;
`packages/core/tests/application-reported-health.test.ts` proves it in
milliseconds by declaring a 20ms budget.

**The rollback remains one phase, not five.** It calls `close` and only `close`
— no `stopAdmission`, no `drain`, no `force` loop. `forceDeadlineAt` is still
passed because an adapter that self-forces inside its own `close` (the managed
server does) needs both ends to compute a budget from. The guide says this
plainly rather than describing the rollback as "a real shutdown", which it is
not.

**One deadline is shared by the whole sweep**, as ADR 0102 requires of the
shutdown loops: *"it cannot create a fresh timeout for each resource"*. A
resource reached after the budget is spent therefore sees a deadline in the past
and gets a zero grace — which is now the correct answer, because the budget
really is spent, rather than the previous answer to a question nobody had asked.
