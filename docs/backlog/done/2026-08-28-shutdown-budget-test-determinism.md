---
title: Make the shared shutdown-budget regression deterministic
description: Assert the shared deadline directly instead of timing a loaded test runner.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 14:34 +0000
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

- [x] Replace the narrow elapsed-time assertion with direct close-invocation evidence.
- [x] Preserve the unfinished-step order assertion.
- [x] Run the exact template regression repeatedly and the full release gate.
- [x] Include the fix in the green `0.68.7` release tree.

## Что сделано

- [x] The unit regression now proves that a queue of hanging resources cannot all start
      under one shared deadline while every resource remains reported unfinished in order.
- [x] Regression: `packages/create-stitchkit/template/scripts/shutdown-budget.test.ts` —
      `the termination budget is an upper bound, not an estimate > the steps share one budget rather than each getting a full one`.
- [x] The exact regression passed 100 consecutive runs; the full file passed 11/11, and
      `bun run verify` plus both packed HEAD starter lanes passed on the release tree.
- [x] The deterministic gate fix shipped in tag `v0.68.7` at
      `c8c96b53cc7822740b6db813ba7d4dafadd0387b`; exact-SHA CI run `33180438608`
      and release run `33180737854` are green.
