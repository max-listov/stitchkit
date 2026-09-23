---
title: "ADR 0200: An effect is recorded before it runs, and settled only by its recipient"
description: "durability.effect records the intent before an external effect and its outcome after; an intent found without an outcome is reconciled with the recipient, never run again, and 'uncertain' is a recorded third answer."
type: decision
status: accepted
created: 2026-09-23
updated: 2026-09-23T12:31+07:00
---

# ADR 0200 — An effect is recorded before it runs

## Context

[ADR 0182](0182-a-durability-port-exposes-step-sleep-and-wait.md) gave durable
bodies `step`, which records a result **after** its body. A body cut short by a
crash runs again on replay, and 0182 says so: the host must make external
effects idempotent. That is correct for a computation and wrong for an effect in
another system — sending a message, starting a model turn, answering a
permission request — where a repeat is worse than a loss.

A consuming project solved this by hand in seven places with one rule: record
the intent before the effect, record what the recipient named it after, and
settle an intent found without an outcome only by the recipient's own record.
One of the seven copies had drifted — it wrote nothing before a permission
reply, so a lost acknowledgement could send the reply twice. A rule that lives
in seven copies drifts again.

## Decision

`LocalStepDurability` gains `effect(name, { run, reconcile }, options)`, beside
`step` in the owner that already exists (I8):

- the intent is appended to the ledger **before** `run`; the proof `run`
  returns is appended after, as `accepted`;
- a call that finds an intent without an outcome calls `reconcile`, never
  `run`. A proof found is recorded as `accepted`; `null` is recorded as
  `uncertain`. Both are final: `run` is never called for that name again, and
  `uncertain` is not reconciled again — it is an answer the caller sees and
  decides on;
- `run` throwing leaves the intent standing and rejects with
  `EffectUnresolvedError`: whether the effect happened is exactly what is not
  known, so the next call reconciles. `reconcile` throwing or overrunning its
  deadline does the same — "could not ask" is not "not there";
- it is bounded (I10): `reconcile` runs under `reconcileTimeoutMs` (default
  30 s) with an abort signal, and a proof is at most 64 KiB of JSON — an
  identity the recipient assigned, not a payload;
- in one process, concurrent calls for the same name share one `run`, as
  concurrent `step` calls share one body.

The records are a new ledger event kind, `durability/effect`, with phases
`intent`, `accepted` (with `via: run | reconcile`) and `uncertain`. The first
outcome recorded wins.

## Consequences

- Effects stop needing a hand-written ledger per call site; a host supplies
  `reconcile` — the lookup at the recipient by its own identity for the effect —
  and the protocol is one implementation.
- `uncertain` is visible and permanent. A host that wants to retry an uncertain
  effect does so under a new name, by its own decision.
- Across processes the guarantee is the ledger's: two processes that append to
  it concurrently are fenced by whatever lease already fences the run, as for
  `step` (0182). `effect` does not add a lease.
- `ToolDurability`, the port a mounted tool body sees, is unchanged: adding a
  required method to a port that hosts implement would break every
  implementation. The engine's own interface carries it.
