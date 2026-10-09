---
title: "ADR 0255: An owner-loss guard belongs to the command group"
description: "An opt-in per-command guard binds a detached native group to its caller through a private inherited kernel channel, without a consumer daemon or PID reclamation."
type: decision
status: accepted
created: 2026-10-09
updated: 2026-10-09
---

# ADR 0255 — An owner-loss guard belongs to the command group

**Invariants:** I8, I9, I10, I11, I13. Amends ADR 0243's statement that only an external
supervisor can bound a command group after its caller dies.

## Context

`runNativeCommand` owns a detached process group while its JavaScript caller is alive. Its signal,
deadline, output bound and `finally` cleanup cannot run after the caller receives `SIGKILL`. A
bounded metadata provider then survives with no process that can close its RPC socket or stop its
group. A consumer-specific watchdog would duplicate the process owner and turn every application
into a daemon supervisor.

Reclaiming a recorded PID later is not an equivalent guarantee. The PID or process-group number may
already identify a neighbour, and process identity may be unavailable. The owner-loss mechanism has
to retain kernel ownership continuously rather than infer it after a gap.

## Decision

1. **`runNativeCommand` owns the opt-in.** `ownerLoss: 'terminate'` adds the guarantee to the
   existing one-shot runner. It requires `group: 'own'`; the default remains unchanged and pays no
   extra process cost.
2. **One package-owned guard becomes the group leader.** The guard launches the requested
   executable as a member of that group and mirrors its stdout, stderr, stdin, exit code and signal.
   A finite handshake makes target launch failure remain `COMMAND_UNAVAILABLE` before
   `onLeaderStarted` runs. Under this option the callback's PID is the guard/group leader, which is
   the PID the caller can safely use for group-scoped evidence and cleanup.
3. **A private inherited descriptor is the lifetime boundary.** Node uses an extra child-process
   pipe and Bun uses an extra `socket-fd`; both are kernel channels, not polling. The caller retains
   one end and the guard retains the other. Abrupt caller death closes the caller's descriptors, so
   EOF makes the guard send `SIGKILL` to its own process group. Graceful completion disarms the
   channel before the guard closes it.
4. **No PID is reacquired.** While the guard can signal the group it is still that group's leader,
   so the numeric PGID cannot be reused. The guard signals only its own negative PID and never asks
   process identity to decide whether an arbitrary recorded PID is safe. Unavailable identity
   therefore cannot widen the target, and a neighbouring group is outside the operation.
5. **Availability is certified, not guessed.** The option is available on Linux and Darwin under
   Bun and Node. Other kernels return `COMMAND_UNAVAILABLE`. A process that deliberately leaves the
   group with `setsid` remains outside this process-group capability, as it is for every other stop.
6. **A lazy bundle bootstraps the same guard before application routing.** The narrow
   `stitchkit/process/owner-loss` entry carries the package implementation into a single output file.
   `bootstrapNativeCommandOwnerLoss()` tells the application only whether the guard owns this
   invocation; the private flag, filename and protocol stay inside the package. The full
   `stitchkit/process` entry may remain behind the application's ordinary dynamic dispatch.

The guard is a finite implementation detail of one command call. It has no durable state, restart
policy, discovery endpoint or shared daemon, so durable jobs and application supervision remain in
their existing owners.

## Consequences

- Any application that needs a native child only while the application process exists can use the
  same public option; the contract contains no metadata-provider or consumer-specific policy.
- Each guarded call uses one extra short-lived process and one private descriptor. Applications
  choose that cost explicitly.
- `descendants: 'terminate-after-leader'` remains the default. A caller that explicitly chooses
  `'leave'` still chooses to leave group members after the target has ended.
- The installed-package lane kills real owners before listen, after initialization and during a
  hanging operation under Bun and Node. Linux runs it in the portable lane; both Darwin
  architectures run it in the packed native lane. The negative control proves the same target
  survives without the option, and an unrelated detached group survives every guarded cleanup.
- The same phases also run from an isolated single-file Bun bundle built from packed bytes, beside
  no `node_modules`; a bundle without the bootstrap is the negative control for entry dispatch.
