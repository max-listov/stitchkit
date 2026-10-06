# 0248 — A stopped leader settles with its exit, and a command may join the caller's group

**Status:** Accepted
**Date:** 2026-10-06

Amends ADR 0243 and ADR 0246. Invariants I8, I9 and I10.

## Context

A consuming project moved its finite commands onto one runner over `runNativeCommand` and kept six
launches on a raw spawn, for three reasons the public contract did not cover.

- **A stopped leader's exit was lost.** On a caller abort, a deadline, an exceeded output budget or
  a failing sink, `onLeaderSettled` received `{ kind: 'error', cause }`, settled at once, before
  the stop signals. How the leader then ended (`SIGTERM`, or `SIGKILL` once the grace ran out) was
  observed by the kernel and never reached the caller. The package's own coding shell worked
  around it by reading the child's `signalCode` after the rejection: two ways to learn one fact.
- **Pipes take the terminal away.** A command whose output passes through `onOutput` sees a pipe,
  not a TTY: no colour, no prompts, `isatty` false.
- **A group of its own takes Ctrl-C away.** Every command led a process group of its own. A
  terminal sends Ctrl-C to its foreground group, which that is not, and the kernel stops a
  background group that reads the terminal (`SIGTTIN`). An interactive command cannot run there.

## Decision

**A stop is not an error: the leader settles as `stopped`, with its exit.**
`NativeCommandSettlement` gains `{ kind: 'stopped', cause, exitCode, signal }`. A stopped command
waits for the stop signals and for the leader's exit (bounded by `cleanupTimeoutMs`), then settles
with the stop's `cause` and the exit the kernel reported. `'error'` keeps one meaning: no exit of
the leader was observed (it could not start, or its exit did not arrive). `'exit'` is a leader that
ended on its own, and a stop that comes after that exit leaves its event unchanged. The hook still
runs once. The coding shell takes the exit from the event and no longer reads the child.

**`stdio: 'inherit'` hands the caller's descriptors to the command.** The bytes never pass through
the package, so every option that acts on a pipe (`capture`, `onOutput`, `stdin`, `maxOutputBytes`,
`drainTimeoutMs`) is refused by name with it rather than silently ignored (I9).

**`group: 'caller'` keeps the command in the caller's process group.** There is no group of the
command's own to act on, so the contract says so in refusals, not in prose: `stop.target` must be
`'leader'` (the default becomes `{ target: 'leader', signal: 'SIGTERM', graceMs: 100 }`), because a
group signal from there would reach the caller; `descendants` is refused, because what the leader
leaves behind is in the caller's group; KILL after the grace reaches the leader alone. `'own'` stays
the default: a detached group is still the safe shape for everything that is not interactive.

**The `setsid` condition of ADR 0246 is a race, and the guide says so.** A descendant is out of
reach when it *had already left* the group when the leader exited. A background `setsid helper &`
usually has not; `setsid -f helper` returns only after the new session exists.

## Consequences

- Breaking for a caller that treated `kind: 'error'` as "the command was stopped": a stop now
  arrives as `'stopped'`. The migration matches both kinds where it handled the stop, and reads the
  leader's exit from the event.
- A stopped command's hook runs after the stop sequence instead of beside it. A resource owner that
  stops an external scope there does so once the leader is gone, still within the same bound.
- Two options and one event kind; no new entrypoint and no second process primitive (I8).
- What stays a raw spawn is named: a daemon (this is no supervisor, ADR 0224) and a shell lock.

## Verification

`packages/core/tests/native-command-terminal.test.ts`: under a real pseudo-terminal (`script`) a
command with `stdio: 'inherit'` sees a TTY on all three descriptors and a piped one does not; a
Ctrl-C typed at that terminal reaches a command with `group: 'caller'` and not one with `'own'`;
`group: 'caller'` shares the caller's process group id and `'own'` does not; a caller-group stop
signals the leader alone with the policy's signal and settles `stopped` with it; inherited bytes
reach the caller's descriptor; the refusals name each option. A stopped leader settles `stopped`
with the stop's cause and `SIGTERM`; a leader that cannot start settles `error`; a leader that
exited on its own keeps `exit` when a later deadline stops the drain.
`packages/core/tests/native-command-reasons.test.ts` keeps the once-only settlement and the cause
order of a failing hook under the new kind.
