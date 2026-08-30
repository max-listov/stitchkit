---
title: Supervised process sessions
description: Provide a bounded host-authorized process and PTY lifecycle for interactive and background coding work.
type: task
status: icebox
created: 2026-08-30
updated: 2026-08-30
priority: P3
pipeline: composable-agent-harness
order: deferred
depends-on: 2026-08-30-agent-control-client-and-view.md, 2026-08-30-agent-approval-continuations.md, 2026-08-30-agent-output-artifacts-and-coding-transactions.md
---

## Зачем

A finite unary shell call cannot drive interactive programs, resize a terminal or retain bounded
background work. Implementing process maps independently in each client creates orphan processes,
unbounded output and inconsistent cancellation.

## Почему icebox

The current foundation already has bounded unary shell execution. PTY portability, orphan cleanup,
resize semantics and process ownership are a distinct subsystem rather than a small harness leaf.
Defrost when two consuming harnesses require the same interactive/background lifecycle and can
validate one shared contract on Bun and Node.

## Результат

- An optional process-local manager owns spawn, streamed output, stdin, resize, terminate, status
  and bounded close for host-declared executables.
- Process handles are opaque, scoped to one manager and protected by authorization and leases.
- Output uses the artifact boundary; transient deltas are UI hints and terminal process state is an
  authoritative snapshot.
- The manager is not a filesystem sandbox, remote scheduler or OS supervisor. The host owns
  isolation, placement, restart and environment policy.

## План

- [ ] Specify process states, ownership, budgets, backpressure and shutdown transitions.
- [ ] Implement pipe mode for Bun and Node; add PTY through an optional peer only if packed support
  and lifecycle semantics are reliable on both runtimes.
- [ ] Connect process controls/events to the control protocol without exposing child objects.
- [ ] Add coding-tool adapters only where direct operation identity remains honest.
- [ ] Cover resize/write races, cancellation, timeout, output overflow, client detach and close.

## Acceptance

- [ ] A packed client can spawn, stream, write, resize when PTY is available, terminate and close.
- [ ] Detach and runtime close cannot leave an unowned child process.
- [ ] Unsupported PTY capability is explicit; pipe execution remains usable without the optional peer.
- [ ] Existing unary `coding_shell` stays available for simple finite commands.
