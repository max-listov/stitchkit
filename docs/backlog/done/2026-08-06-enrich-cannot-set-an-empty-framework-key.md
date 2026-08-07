---
title: "enrich cannot set errorCode — the framework's empty key wins anyway"
description: buildLogFields always emits errorCode, undefined included, and the merge puts framework fields last — so a raw route that answers with an error Response drops the consumer's code silently while the audit row keeps it.
type: task
status: done
created: 2026-08-06
updated: 2026-08-07
related: docs/decisions/0039-request-logging-reads-the-request-context.md
completed: 2026-08-07 07:07 +00:00
---

# `enrich` cannot set `errorCode`

> **Target release:** 0.37.0.

## Reported, and verified here

A consuming project tried to put an `errorCode` on the access-log line of a raw
route through `logging.enrich`. It never appeared — the key is absent from the
line entirely — while the same code reached their audit row through
`setRequestError` without trouble. They reverted their change rather than leave
dead code, and reported it because *"for another consumer this looks like enrich
silently not working"*.

Confirmed in the source, and the cause is one deliberate line of mine from 0.28:

- `buildLogFields` (`server/logger.ts:97-113`) always returns the `errorCode`
  key, `undefined` on success. Its own comment says why: *"a conditional key
  would let an `enrich` value survive on a 200"*.
- `structuredLine` (`server/logger.ts:183`) merges `{ ...extra, ...own }`, and
  the custom-logger branch does the same (`server/create.ts:189-197`). Framework
  fields are last, so they win — **including when the value is `undefined`**.

So the guard against a *forged* code also blocks a *legitimate* one, and it does
it without a word.

## Why the reporter's case is not forgery

Their route is a **raw route** answering with a normal error `Response` rather
than throwing. The framework therefore derives no code of its own — nothing was
normalised, `logDone` is called with `errorCode` unset — and the consumer's value
is the only description of the failure that exists. The line ends up with an
`errorMessage` and no `errorCode`, which is worse than either extreme: it looks
like a partially populated record rather than an unsupported field.

The distinguishing property is **not** "does the framework have a value". On a
200 the framework has none either, and there an `enrich` code genuinely is a lie —
that is the case 0.28 was right to block. The property is the **outcome**.

## Plan

**1. The rule.** `enrich` may supply `errorCode` only when both hold:

- the framework derived none (`errorCode` argument to `logDone` is `undefined`);
- the outcome is a failure — `status >= 400`.

On a 2xx/3xx the framework's `undefined` keeps winning, so a code cannot be
forged onto a success. Everything else about precedence is unchanged: `traceId`,
`method`, `path`, `status`, `durationMs` and `ip` still win unconditionally,
because for those the framework always has the truth.

**2. Where.** The merge happens in two places and both must follow one rule, or
the built-in formatter and a custom `logger` disagree about what a line contains:

- `server/logger.ts:222-229` — the structured branch builds `own` then calls
  `structuredLine(own, extra)`.
- `server/create.ts:186-202` — the custom-logger branch spreads
  `{ ...extra, ...buildLogFields(...), ip }` by hand.

Cleanest shape: give `buildLogFields` the decision rather than duplicating it at
two call sites — it already receives `status` and `errorCode`, so it can omit the
key when it has nothing to say *and* the status is an error, and emit
`errorCode: undefined` otherwise. Then both sites keep spreading it last and the
rule lives in one function with its reason next to it.

**3. Say it out loud when it is dropped.** A silent no-op is what made this cost
a consumer an implementation and a revert. Warn **once per handler** — the
`traceResolverBroken` pattern in `create.ts:84-100` is the precedent — when
`enrich` returns a key the framework owns and the value is discarded. One line,
naming the key, not one per request.

Worth deciding while implementing: warn for **every** owned key
(`traceId`, `status`, …) or only where a consumer could plausibly believe it
should work. Leaning towards every key: the surprise is identical, and a project
that meant it can stop sending it.

**4. Documentation.** `docs/guide/server.md:153-156` currently says *"framework
fields (`traceId`, `status`, `path`, …) always win a key collision"*. True, and
it hides exactly the surprising part — that the win happens **when the framework
field is empty too**. Name the owned keys in full, state the one exception this
task introduces, and say that a dropped key is warned about rather than silently
ignored.

## Acceptance

- [x] `enrich` can set `errorCode` on a failing request where the framework
      derived none — the reporter's exact shape: a raw route answering `4xx`/`5xx`
      with a `Response` rather than a throw
- [x] `enrich` still **cannot** set `errorCode` on a 2xx/3xx — pinned, this is
      the reason the unconditional key exists (→ 0.28)
- [x] A framework-derived `errorCode` still wins over an `enrich` one on a
      failure — the framework knows the contract code, `enrich` is guessing
- [x] Both the built-in formatter and a custom `logger` produce the same key set
      for the same request — asserted together, not one at a time
- [x] A dropped owned key warns once per handler, not once per request
- [x] `docs/guide/server.md` — the owned keys named in full, the exception, the
      warning
- [x] `CHANGELOG.md` — additive; a line that previously had no `errorCode` may
      now have one, which a strict log consumer should know
- [x] No ADR expected: this refines a rule ADR 0039 already owns rather than
      making a new decision. Write one if the "outcome decides" framing turns out
      to need an argument of its own — no separate ADR was needed

## Not doing

- Letting `enrich` override a framework-derived value. The framework has the
  contract's own code; a consumer wanting a different one has `logger`.
- Reverting 0.28's unconditional key wholesale. It exists for a real case and
  the reporter's is not that case — the fix is to narrow it, not undo it.

## Note on urgency

The reporter is not blocked: their raw routes move into the contract as
`rawResponse` endpoints (unblocked by our own 0.27), and the need disappears with
them. This is worth doing for the consumer who has no such plan and reads the
guide's promise literally.

## Что сделано

- [x] **Policy:** `packages/core/src/server/logger.ts` omits an empty framework
      `errorCode` only for `4xx`/`5xx`, preserving the anti-forgery field on
      `2xx`/`3xx` and framework precedence whenever a real code exists.
- [x] **Both sinks:** `packages/core/src/server/create.ts` builds the shared
      framework fields once and applies the same merge decision to built-in JSON
      and custom loggers.
- [x] **Diagnostics:** `packages/core/src/server/logging.ts` reports enrichment
      keys separately so discarded owned keys warn once per handler and key.
- [x] **Tests:** `packages/core/tests/request-logging.test.ts` covers raw errors,
      2xx/3xx anti-forgery, derived-code precedence, sink parity and warning
      cardinality; all 29 request-logging tests are green.
- [x] **Docs/package:** server guide, public type docs, changelog and generated
      LLM docs describe the outcome-aware exception; lint, typecheck and build
      are green.
