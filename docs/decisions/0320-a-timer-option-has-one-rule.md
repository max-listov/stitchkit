---
title: "ADR 0320: A timer option has one rule"
description: "Every millisecond option that ends in a timer is checked by one function, assertTimerMs: a value that is not a number is a TypeError, a number outside 1…MAX_TIMER_MS or not an integer is a RangeError, before any side effect; the copies that answered the same value differently are removed, stable entrypoints included."
type: decision
status: accepted
created: 2026-11-24
updated: 2026-11-24
---

# ADR 0320 — A timer option has one rule

Serves **I8** and **I10**. Amends the option checks of `stitchkit/tools` (`reconcileTimeoutMs`) and
`stitchkit/tools/connections` (`timeoutMs`, `idleTimeoutMs`), both stable
([ADR 0198](./0198-stable-is-earned-and-kept-on-a-budget.md)).

## Context

A millisecond option that ends in `setTimeout` has two limits the platform sets, not the author: it
must be an integer the timer keeps, and it must not exceed the largest delay a timer holds
(`MAX_TIMER_MS`, about 24.8 days); a larger one fires at once. The library checked this in several
places, each its own way:

- one accepted a fraction (`reconcileTimeoutMs: 1.5`), another refused it;
- one answered a value out of range with `TypeError`, another with `RangeError`, a third with a
  `ZodError`;
- one checked at the first `load()`, long after the component was built, and one after a child
  process had already started, so a refused option left a running process behind.

A caller could not know, from one option, what the next option of the same kind would answer, and a
fix to the rule in one copy did not reach the others.

## Decision

1. **One function.** `assertTimerMs(name, value)` in `internal/deadline.ts` is the rule: not a
   number → `TypeError`; not an integer, below 1, or above `MAX_TIMER_MS` → `RangeError`, the message
   naming the option and the value.
2. **Checked where the option is taken, before any side effect.** A factory or constructor calls it
   on its options before it starts a process, a timer or a connection.
3. **No second implementation.** The imperative copies call `assertTimerMs`. A Zod schema that
   declares a timer field keeps its schema — the field is part of a parsed document and answers with
   the `ZodError` naming the field — and states its own lower bound only where its domain needs one.

## Consequences

- `reconcileTimeoutMs` refuses a fractional value, and both it and a connection's `timeoutMs` /
  `idleTimeoutMs` answer an out-of-range value with `RangeError` instead of `TypeError`. Code that
  branches on the error class migrates by
  [`timer-options-one-rule`](../guide/upgrading.md#timer-options-one-rule).
- A new timer option gets the rule by calling one function; its test proves the option, not the rule.
