---
title: "ADR 0076 — Explicit process-signal binding (bindProcessSignals)"
description: The framework ships the signal state machine as an explicit opt-in binding while still registering no listener of its own and never choosing an exit code.
type: decision
status: accepted
created: 2026-08-17
updated: 2026-08-17
---

# ADR 0076 — Explicit process-signal binding (`bindProcessSignals`)

- **Status:** Accepted — supersedes the signal clause of
  [ADR 0074](0074-server-owned-managed-shutdown.md)
- **Date:** 2026-08-17

## Context

ADR 0074 gave the server one managed `shutdown()` and drew the ownership line at
the process: *"core never registers process signals. Apps wire signals
explicitly"*, and srvx runs with `gracefulShutdown: false` so nothing hidden
listens.

That line is right and stays. What it did not anticipate is that "wire signals
explicitly" is not a one-liner. `shutdown()` is idempotent and parses its options
only on the first call, so the **only** way a later signal can influence a
running chain is the `AbortSignal` handed to that first call. Every application
therefore rewrites the same state machine, and the hand-written versions
consistently miss these states:

- **A signal during asynchronous preparation.** Stopping schedulers before
  `shutdown()` means there is a window with no chain and no controller yet; a
  signal arriving there is lost.
- **A rejected shutdown.** `shutdown()` rejects on a phase failure, on a forced
  cleanup that itself failed, and with an `AggregateError` when both fail. The
  cached promise is cached *rejected*, and a chain nobody caught surfaces as an
  `unhandledRejection`.
- **A third signal.** The first `process.on` suppresses the signal's default
  disposition. Once the chain is already forced, further signals do nothing —
  so a process stuck on a resource outside the transport boundary can no longer
  be killed with anything short of `SIGKILL`, precisely when the operator is
  pressing Ctrl+C for the third time.

## Decision

Ship **`bindProcessSignals(handle, options)`** in `stitchkit/server` (and
`stitchkit/node`, which re-exports explicitly — it does not re-export
`server/index.ts`).

The ownership line of ADR 0074 is preserved and made precise: the framework
still registers **no** listener of its own. Binding is an explicit call, `close()`
takes it back, and the module contains no `process.exit` — the exit code stays
supervisor policy, set by the application in `onComplete` / `onError`.

The machine is `idle → preparing → running → settled`:

- the `AbortController` is created **before** `onShutdown`, so a signal in the
  preparation phase is not lost — `shutdown()` accepts an already-aborted signal
  and takes its forced path;
- a later signal aborts that controller — the same chain, never a second one.
  Signals delivered in the **same turn** as the first do not count: a supervisor
  that sends `SIGINT` and `SIGTERM` together must not collapse the declared grace
  period to zero. Duplicate names in `signals` are deduplicated for the same
  reason;
- any signal after the force, or one arriving while `onComplete` still runs,
  removes the listeners and re-raises the signal so its default disposition
  applies;
- **failure is routed by phase, not flattened.** A failing `onShutdown` is
  reported as `prepare` and the shutdown still runs — a failed preparation must
  not leave the server listening with nobody draining it. A failing `onComplete`
  is reported as `complete` while `promise` stays resolved, because the transport
  really did shut down. Only a failing `shutdown()` rejects the chain;
- state is mutated **before** user callbacks run, and every callback is wrapped:
  a throwing `onRepeatedSignal` cannot swallow the force, and a callback that
  re-enters through a custom `SignalSource` finds the machine already advanced;
- nothing escapes into a signal handler: `run()` is caught, the returned
  `promise` is internally observed, and an `onError` that itself throws is
  swallowed rather than crashing the process mid-shutdown.

Options are a plain `interface`, not a Zod schema: most of its fields are
callbacks and one is an injected source, none of which Zod can meaningfully
validate. Only the forwarded shutdown budgets are parsed — with
`ShutdownOptionsSchema.omit({ signal: true })`. The type rejects a caller-supplied
`signal`; at runtime the schema strips it, as Zod strips any extra key.

The signal source is injectable (`SignalSource`), following `RunCliConfig`, so
the machine is testable without patching globals or writing a cast.

## Consequences

- A consumer's shutdown wiring drops to one call, and the missed states are
  handled by construction.
- The binding accepts `Pick<ManagedServerHandle, 'shutdown'>`, so a test fakes one
  method instead of a whole server.
- One binding per handle; a second throws. The guard is released only while the
  binding is **idle**: closing a binding whose chain is already running keeps the
  handle claimed, because `shutdown()` parses its options once and would ignore a
  second binding's `AbortSignal` while resolving its `promise` with the first
  chain's result.
- **Escalation is best-effort, and says so.** Re-raising the signal restores the
  default disposition only while nothing else in the process listens for it; a
  logger, a REPL or another binding would swallow it and the process would
  survive. The default source checks `process.listenerCount` and reports through
  `onEscalationBlocked` instead of promising a kill it cannot perform. The
  framework still refuses to call `process.exit` itself.
- **This does add runtime behaviour**: the escalation path ends a process via
  `process.kill(process.pid, signal)`, which nothing in the framework did before.
  Forcing by a second real signal is unchanged and stays proven by the existing
  Bun and Node signal subprocess stands.
- The official starter keeps its hand-written wiring for now: its lane resolves
  the published Stitchkit range, so it can only adopt this after release.
- `SIGTERM` cannot be listened for on Node/Windows; the default signal set is
  documented rather than special-cased.
