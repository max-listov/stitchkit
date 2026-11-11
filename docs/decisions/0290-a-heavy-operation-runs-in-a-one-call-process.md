---
title: "ADR 0290: A heavy operation runs in a one-call process"
description: A contract operation may execute in a child process started for that one call, with a bounded count, a bounded answer and no queue; this is not a supervisor.
type: decision
status: accepted
created: 2026-11-11 14:30 +07:00
updated: 2026-11-11 14:30 +07:00
---

# ADR 0290 — A heavy operation runs in a one-call process

Serves **I1**, **I10**, **I11**.

## Context

A server answers its operations on one event loop. An operation that reads gigabytes holds that
loop for as long as it reads, and an operation that answers in milliseconds waits behind it. A
consuming project had already written the remedy once by hand — start its own executable with a
private argument, hand it the call, read a bounded answer — and every application that grows such
an operation writes the same four things: the launch, the cancellation, the bound on the answer
and the bound on how many run at once.

`stitchkit/process` already owns the hard part: a finite native command with a deadline, a byte
budget, process-group cleanup and cancellation. What it lacked was the join to a contract.

PRINCIPLES keeps a process supervisor and a job queue out of the framework (I11), so the join
has to stay on the near side of that line.

## Decision

`createOperationProcesses` returns ordinary contract handlers — `unary` and `stream` — that run
one call in one child process:

- **One call, one process, nothing in between.** A call starts a process and the call's end —
  its answer, its failure, the caller's abort, the deadline — ends that process and its group.
  No process outlives its call, none is kept warm, restarted or health-checked. That is the
  difference from a supervisor: there is no lifetime here that is not a request's.
- **A count, not a queue.** `maxConcurrent` bounds the processes running; a call beyond it is
  refused at once with `OPERATION_BUSY`. Nothing waits in memory for a slot, because an unbounded
  queue is the same exhaustion the process boundary exists to prevent (I10). Retrying is the
  caller's decision, and the refusal says it may.
- **The contract stays the only declaration (I1).** The handlers are mounted with `implement`, so
  routing, the auth gate, input validation and output validation are the server's usual ones. The
  child runs the same `implement(contract, handlers)` services through `runOperationProcess`.
- **Everything that crosses is bounded and typed.** The call is JSON on stdin, at most 64 MiB;
  the answer is JSON on stdout, at most `maxResponseBytes` — per answer or per stream item — and
  more is `OPERATION_RESPONSE_TOO_LARGE`. A refusal thrown in the child arrives as that refusal;
  a child that dies is `OPERATION_PROCESS_FAILED` with its stderr kept for the log only (I13).

The code lives in the process part and imports the contract part for the error type and the
stream error envelope; the import graph declares that edge.

## Consequences

Values cross the boundary as JSON, so an operation whose input or output parses to something
JSON cannot carry — a `Date`, a `Map` — cannot run this way; the output check refuses it. A
process start costs what the runtime's start costs on every call, which is the price of an idle
loop; an operation cheap enough to mind that price belongs in process. A stream holds its slot
until it ends or its reader leaves, and its deadline is the contract's `stream.lifetimeMs`.
