---
title: "ADR 0223: The candidate's unit tests are checked by the required CI"
description: The structural preflight of a release branch does not repeat unit tests and does not issue a fast attestation.
type: decision
status: active
created: 2026-10-01 16:40 +07:00
updated: 2026-10-01 16:40 +07:00
---

# ADR 0223 — The candidate's unit tests are checked by the required CI

## Decision

For a release commit pushed to a remote release branch, pre-push keeps metadata,
privacy, frozen lockfile, lint and types. All unit tests and the selected lanes are
run by the full exact-SHA push CI; only its green evidence authorises master/tag/npm.
An ordinary push keeps the fast gate, an unverified direct master push keeps the
full gate. A mixed push that includes an ordinary branch does not get the lighter
profile.

The candidate record is called `verify:candidate` and is not evidence for
`verify:fast`: it contains no tests. The full/release fast attestation of ADR 0222
is stored only after the full fast subset. The full diagnostic commands stay
available. This refines the local candidate profile of ADR 0222; its other
decisions remain in force.
(Amended by ADR 0247: the candidate also runs the tests that read release metadata.)

## Reason and limits

Real releases showed about 95s of a repeated local test stage before the same
mandatory CI tests. Moving this stage into the single mandatory CI does not reduce
publication coverage. A different SHA, a PR run and a red/cancelled CI do not
authorise publication. Protected npm OIDC, pins, privacy, native qualification and
the check of published bytes do not change. GitHub/npm queues remain a measurable
external wait; the local saving is not a guarantee of their duration.

Serves P.
