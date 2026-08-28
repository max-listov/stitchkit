---
title: Make the shared shutdown-budget regression deterministic
description: Assert the shared deadline directly instead of timing a loaded test runner.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
---

# Make the shared shutdown-budget regression deterministic

Priority: P1 release gate.

## Why

The template regression for a shared cleanup deadline compares a 25 ms budget with
a 50 ms wall-clock ceiling. Under release-gate load the scheduler can resume the
expired timer after that ceiling even though `closeWithinBudget` correctly gives the
second step no fresh budget. The assertion measures runner latency rather than the
state-machine invariant and can reject a green release tree.

## Result

The test proves directly that a queue of hanging steps cannot all receive a fresh
deadline, while every step remains reported unfinished in declaration order. No
narrow wall-clock threshold or exact timer-rounding boundary remains in this unit
regression; the process-level tests keep the deliberately broad physical termination
bound.

## Plan / acceptance

- [ ] Replace the narrow elapsed-time assertion with direct close-invocation evidence.
- [ ] Preserve the unfinished-step order assertion.
- [ ] Run the exact template regression repeatedly and the full release gate.
- [ ] Include the fix in the green `0.68.7` release tree.
