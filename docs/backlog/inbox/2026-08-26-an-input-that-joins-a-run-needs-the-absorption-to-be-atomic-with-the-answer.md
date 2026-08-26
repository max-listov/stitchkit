---
title: An input that joins a run needs the absorption to be atomic with the answer
description: inject shipped in 0.63.0 and was withdrawn in 0.65.0; the redesign commits the absorption with the terminal record instead of at a step boundary.
type: task
status: inbox
created: 2026-08-26
updated: 2026-08-26
related: docs/backlog/done/2026-08-25-an-input-cannot-join-a-run-already-in-flight.md
---

## Зачем

`inputPolicy: 'inject'` shipped in 0.63.0 and was withdrawn in 0.65.0 after an
adversarial read found four defects that all trace to one ordering mistake:
**the absorption was committed durably at a step boundary, before the answer
existed.**

Everything followed from that:

- `absorbed` became the only run state that is neither active, nor recoverable,
  nor terminal — a durable dead end. `listActive` and `scanRecoverable` exclude
  it, `recoverRun` refuses it, `terminalState()` cannot produce it.
- `close()` between the absorb and the answer reported `settled: true` while
  leaving the input permanently unanswerable, invisible to recovery, and its
  idempotency key **refused forever** on retry — the exact case idempotency keys
  exist for.
- The absorb re-projected the whole snapshot, so an unrelated queued input
  reached the model inside a run that never recorded it and was then answered a
  second time by its own run.
- `inject` + `coalescePending` refused a legitimate submission, because the
  reservation pointed at a run that had since become `absorbed`.

The capability is still worth having. It is right whenever the new input refines
rather than redirects and the finished steps are still valuable.

## Результат

- A run in flight can take on a queued successor's input, and no ordering exists
  in which an accepted input becomes unanswerable.

## План

- [ ] **Commit the absorption with the terminal record, not at the boundary.**
      The loop may put the pending input into the *prompt* at a step boundary —
      that part was right — but nothing durable changes until the run settles.
      A run that ends first, crashes, or is closed leaves an ordinary queued
      successor, which is the behaviour every other policy already has and needs
      no new state to express.
- [ ] Decide whether the absorbed record keeps a distinct state at all. If the
      absorption lands with the terminal, the successor can simply be terminal
      too, with a reason that says why — which keeps it inside every existing
      enumeration instead of outside all of them.
- [ ] Project the run's **own** inputs plus prior committed turns, never the raw
      snapshot: an unrelated queued input must not reach the model.
- [ ] Make the duplicate-submission path resolve through whatever pointer the
      design ends up with, and prove it across a simulated restart, not only
      in-process.
- [ ] Cover the operation in `runAgentStoreConformance`, including that a driver
      which persists only one of the two run records fails the kit.
- [ ] Compose with `coalescePending` and prove it, rather than shipping two
      features that were each tested alone.

## Acceptance

- [ ] A test kills the process between the boundary and the terminal commit and
      shows the input is answered by an ordinary successor.
- [ ] A test closes the runtime mid-run and shows no accepted input is left
      unanswerable, with `close()` reporting honestly.
- [ ] A test retries the same idempotency key after a restart and gets the
      answer, not an error.
- [ ] A test shows an unrelated queued input never reaches the absorbing run's
      prompt.
- [ ] A test covers `inject` together with `coalescePending`.
- [ ] The conformance kit fails a driver that persists one record of the pair.
