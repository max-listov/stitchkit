---
title: One decision vocabulary, and an unanswered question is an error
description: A listener voting on an event and a policy voting on a request answer the same question, so they share one schema; a pipeline where every voter defers raises rather than picking an outcome for it.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0155 — One decision vocabulary, and an unanswered question is an error

## Decision

`allow` / `deny` (with a reason) / `defer` is **one** type, `PolicyDecision`,
defined in `internal/decision.ts` and re-exported by both the entrypoints that
need it: `stitchkit/live` for an event topic declared `mode: 'decision'`, and
`stitchkit/application` for `createDecisionPipeline`.

It was previously two — `EventDecision` in the events declaration and an
identical shape in the pipeline. Two names for one thing is the failure this
repository refuses everywhere else: a reader searching for one finds half the
truth, and the next contributor honestly adds a third.

`UndecidedOutcome` (`'allow' | 'deny'`) is shared the same way: it is what a
topic's `whenAllDefer` and a pipeline's undecided policy both name.

## A deny carries a reason, by schema

`deny` without a reason is not representable. A refusal whose cause exists only
in the log of whoever refused is a support ticket, and the moment it is needed is
the moment nobody can reproduce it.

## Every policy deferring is not an outcome

A pipeline that reaches its end with nobody claiming the question raises
`DecisionUndecidedError` rather than choosing. Both defaults are wrong in a way
that looks like working software: defaulting to `allow` turns an incomplete
policy set into an open door, and defaulting to `deny` turns it into an outage
whose cause reads as a legitimate refusal.

Raising is the only answer that says what actually happened — nobody here can
answer this — and it is loud at the moment the policy set is wrong rather than
at the moment it matters.

## The trace is what ran

`DecisionResult.trace` lists the policies that were actually invoked, in order,
and stops at the terminal verdict. It is not the declared list annotated with
outcomes.

The distinction is the whole value of the trace: when a request was denied, the
question is which policy denied it and what the ones before it said — and a
trace that included policies which never ran would answer that question wrongly
while looking complete. The first terminal verdict short-circuits; the rest do
not run, and do not appear.

A policy that throws or times out is a `DecisionPolicyError` and denies with the
policy named. A policy that is broken must not be a policy that is skipped.

## Duplicate ids are refused at construction

Two policies under one id make the trace ambiguous exactly when it is being read
to explain a refusal — the worst moment to discover it. So `createDecisionPipeline`
refuses them when the pipeline is built, not when a decision is made.
