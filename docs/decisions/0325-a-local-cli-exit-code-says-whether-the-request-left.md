---
title: "ADR 0325 — A local CLI's exit code says whether the request left"
description: "A CLI whose command fails on createUnixClientTransport exits 9 when the request never left (not-dispatched), 10 when it may have reached the application (possibly-dispatched) and 1 when an answer came back, with the transport's UNIX_* code as the error code; each stays overridable through exitCodes."
type: decision
status: accepted
created: 2026-11-25
updated: 2026-11-25
---

# ADR 0325 — A local CLI's exit code says whether the request left

Serves **I13**: a failure reports what the transport observed about delivery. Breaks the exit code of `stitchkit/cli` (stable,
[ADR 0198](./0198-stable-is-earned-and-kept-on-a-budget.md)) for a command that fails on the unix
transport. Builds on [ADR 0116](./0116-a-selected-unix-transport-never-becomes-tcp.md), whose
transport already states the delivery of every failure.

## Context

`createUnixClientTransport` tells a failed call apart by delivery: `not-dispatched` (the request
never reached the application), `possibly-dispatched` (it left and the connection dropped before
the answer) and `response-received`. A CLI that called a local application through it exited `1`
for all three, so a script could not tell "start the application and retry" from "inspect the
state before repeating a call that may have run".

## Decision

1. A command that fails on the unix transport answers with the transport's `UNIX_*` code.
2. `DEFAULT_EXIT_CODES` maps `not-dispatched` codes to `9`, `possibly-dispatched` codes to `10`
   and `response-received` codes to `1`; the message names the socket path or says the outcome is
   unknown and the call was not retried.
3. `exitCodes` overrides each, as for every other code.

## Consequences

- A script that branched on exit `1` for a local application that is not running reads `9`; one
  that keeps `1` sets `exitCodes` for the `UNIX_*` codes. The migration is
  [`cli-unix-delivery-exit-codes`](../guide/upgrading.md#cli-unix-delivery-exit-codes).
- The CLI guide lists the codes of each class.
