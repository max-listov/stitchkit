---
title: "ADR 0324 — A count, a size or an age is a safe integer, refused where it is taken"
description: "An option that is a count, a byte size or an age that ends in no timer is checked by the shared integer rules where the factory takes it — a positive or non-negative safe integer, else the owning API's error, TypeError by default — never read as no limit or zero."
type: decision
status: accepted
created: 2026-11-25
updated: 2026-11-25
---

# ADR 0324 — A count, a size or an age is a safe integer, refused where it is taken

Serves **I8** and **I10**. Breaks the option checks of `createChunkSpool` (`stitchkit/files`,
stable, [ADR 0198](./0198-stable-is-earned-and-kept-on-a-budget.md)) and
`createTelegramOperatorChannel` (`stitchkit/telegram`). The companion of
[ADR 0320](./0320-a-timer-option-has-one-rule.md), which decides the options that end in a timer.

## Context

A limit that is not a whole number is no limit. Two factories took theirs unchecked:

- `createChunkSpool` checked `chunkBytes` and nothing else: a `NaN` `staleAfterMs` made `sweep()`
  remove every upload, and a fractional `maxFileBytes` or `staleAfterMs` was used as written;
- `createTelegramOperatorChannel` checked nothing: `maxAttempts: NaN` retried forever,
  `maxQueued: NaN` queued without bound, and a negative or `NaN` `minIntervalMs` became 0.

The rule for such a value already existed once, in `internal/positive-integer.ts`, and most of the
framework's limits already called it.

## Decision

1. **The shared rules.** A count or a byte size is a positive safe integer
   (`assertPositiveSafeInteger`); an age or a position that may be 0 is a non-negative one
   (`assertNonNegativeSafeInteger`). The refusal is the owning API's error, `TypeError` unless that
   API already throws another, and names the option and the value.
2. **Checked where the option is taken,** before anything is opened, queued or swept; `undefined`
   keeps its documented default.
3. **A millisecond option that ends in a timer follows ADR 0320**, not this rule
   (`minIntervalMs` of the operator channel is one).

## Consequences

- `createChunkSpool` refuses a `maxFileBytes` that is not a positive safe integer and a
  `staleAfterMs` that is not a non-negative one (`TypeError`) when it is created, where it used the
  value; `createTelegramOperatorChannel` refuses a `maxQueued` or `maxAttempts` that is not a
  positive safe integer (`TypeError`) and a `minIntervalMs` outside the timer rule (`RangeError`).
  Code that passed a computed fraction rounds it; the migration is
  [`timer-options-one-rule`](../guide/upgrading.md#timer-options-one-rule).
- A new count, size or age option calls the shared rule; its test proves the option, not the rule.
