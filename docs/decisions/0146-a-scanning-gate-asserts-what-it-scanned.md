---
title: A scanning gate asserts what it scanned
description: A test that discovers its own inputs must assert the size of the set it found before asserting that the set is clean, because an empty scan and a clean scan produce the same green.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0146 — A scanning gate asserts what it scanned

## Decision

A test that **discovers** the files it checks — a glob, a directory walk, anything whose input
set is not written out in the source — asserts the size of that set before asserting the set is
clean. The assertion is a floor or a per-source non-zero count, never an exact number: it exists
to separate *looked and found nothing* from *did not look*, not to pin a count that ordinary
churn will move.

Three gates in `packages/core/tests` now carry one:

- `no-raw-control-bytes.test.ts` — `scanned > 100` over `src/**/*.ts` (270 today).
- `no-fixed-ports.test.ts` — every one of its three roots contributed at least one file.
- `current-docs.test.ts` — a documentation directory contributing nothing throws, so both tests
  built on that helper fail rather than narrow.

## Why the numerator alone is not evidence

`expect(offenders).toEqual([])` is the natural last line of such a test, and it is true in two
situations that mean opposite things. The set was scanned and nothing was wrong; or the set was
empty and nothing could be wrong. Both print the same green, and the second arrives by ordinary
maintenance — a package re-laid out, a directory renamed, a build step moved — with no error
anywhere, because a glob over a path that no longer matches is not a failure, it is zero results.

This is not hypothetical here. `no-fixed-ports.test.ts` exists because of an observed
`697 pass / 0 fail` where 700 were expected: a module-scope bind threw, the file dropped out of
the run, and the suite reported green on tests it never executed. That incident is written in
that file's own header — and the gate written to prevent its class had the same hole in its own
scan. A lesson recorded in prose next to the code did not transfer to the code. That is the
argument for a rule that fails rather than a paragraph that explains.

## Why a floor and not an exact count

An exact count is a second copy of the tree's contents, and it goes red on every added file —
which trains the reader to update the number without reading why it moved. A floor is
approximately free to maintain and still catches the only failure that matters, because the
failure mode is collapse to zero, not a drift of five. Where the set has independent sources, the
sharper assertion is per-source: `no-fixed-ports` scans three roots, and a total floor would still
be met by two of them while the third silently stopped being checked.

## Relationship to the option-effects rule

This is the same defect one level out. `option-effects.test.ts` exists because a typed option
proves only that it can be **passed**, never that passing it changes anything; a scanning gate's
green proves only that the assertion **ran**, never that it had anything to run against. Both are
cases of a check whose success is indistinguishable from its own absence, and both are answered
the same way — by naming the thing that must be non-empty and failing when it is not.

## Consequences

- A new gate that discovers its inputs is incomplete until it asserts its denominator; this is a
  review rule over a countable set, like the `as`-cast rule, not a mechanical gate. A gate that
  checked gates would need a denominator of its own.
- The floors here were measured, not guessed, and each was falsified by collapsing its scan and
  confirming the test goes red. A denominator nobody has seen fail is the assertion it replaced.
- Nothing about the checked conditions changed. These three gates test exactly what they tested
  before; they now also state what they looked at.
