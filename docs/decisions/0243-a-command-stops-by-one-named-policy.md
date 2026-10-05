# 0243 — A native command stops by one named policy, and the host bounds only what it outlives

**Status:** Accepted
**Date:** 2026-10-05

Amends ADR 0224. Invariants I8, I9, I10 and I11.

## Context

`runNativeCommand` stopped every cancelled command the same way: TERM to the whole process group,
`killGraceMs` (at most 10 s), then KILL. A consuming project needs cooperative cancellation
instead: only the leader is asked to stop, because it is the one process that knows how to roll
its work back, and it may need minutes for it. Signalling the group asks the leader's own helpers
(a database client, a package manager) to stop under it. That project kept its own process
termination code because the shared one could not express this, which gave the family two
implementations of the same job.

Two more questions came with it. What bounds the group when the host process exits before the
grace ends? And how does a long cooperative grace fit an application shutdown budget of seconds?

## Decision

**One `stop` policy object replaces `killGraceMs`.** `stop: { target, signal, graceMs, killOn }`:

- `target: 'group'` sends `signal` to every member and waits for the group to leave; `'leader'`
  sends it to the leader alone and waits for the leader to exit. Both end in KILL to the whole
  group. With `'leader'`, the leader's exit ends the grace at once: what is left in the group are
  processes the leader started, and nothing in them was asked to cooperate.
- `signal` is a closed set of catchable signals (`SIGTERM` default). KILL is what a grace ends in,
  not a stop signal.
- `graceMs` goes up to one hour. The stop runs on native timers, and an hour leaves a wide margin
  inside their range; the group probe backs off to 250 ms so a long grace stays cheap.
- `killOn` is an `AbortSignal` whose abort stops the command with KILL to the whole group at
  once, also in the middle of a grace. It is how a host that has to stop sooner than the grace
  bounds the stop.

`target` and `graceMs` are required inside the object (I9: the reader sees which stop it is); the
whole policy defaults to `{ target: 'group', signal: 'SIGTERM', graceMs: 100 }`, the previous
behaviour. `descendants: 'terminate-after-leader'` keeps its meaning and follows the policy: with
`target: 'leader'` the leader has already exited, so its leftovers get KILL at once.

**The pipes stay open through the stop.** Cleanup closes the output pipes only after the stop
sequence; while it runs, output is read and dropped, never handed to a sink or captured. A leader
that writes while it shuts down would otherwise meet a broken pipe and die of it, which turns
cooperative cancellation into a kill.

**Nothing in this package bounds a group after its host exits.** The command's group is detached
into its own session, so it gets no signal when the host dies, and every timer of the grace dies
with the host. A reaper or watchdog process would be a supervisor, which ADR 0224 rules out and
I11 keeps out of the composition. The bound belongs to the process supervisor: systemd's default
`KillMode=control-group` stops every process in the unit's cgroup whatever its process group;
launchd only kills the job's own process group, which a detached command's group is not. A host
that shuts down on purpose aborts `killOn` before it exits.

**A resource does not declare its drain time to the application.** A composition-time check of a
declared drain against `gracePeriodMs` would bound nothing: `shutdown()`, `restart()` and the
signal binding can each pass a smaller budget at the call, a shutdown is never refused, and the
supervisor's stop timeout, the bound that really ends the process, is invisible to the
application. The existing mechanism answers the question instead: a resource reads
`context.deadlineAt` and `context.forceDeadlineAt` in its `drain`, and its `force` aborts the
`killOn` of the commands it still runs.

## Consequences

- One stop implementation serves both shapes; a consumer drops its own termination code for
  `stop: { target: 'leader', … }`.
- Breaking for callers that pass `killGraceMs`; the migration is one mechanical replacement.
- A stopped command's result rejects up to `graceMs` plus `cleanupTimeoutMs` after the abort, the
  same rule as before with a longer possible grace.

## Verification

`packages/core/tests/native-command-stop-policy.test.ts` runs real fixture processes: a leader-only
signal reaches the leader and not its group member, the leader's exit ends a one-minute grace,
the member left behind is killed, a leader that ignores the signal is killed with its group when
the grace ends, an abort of `killOn` ends a one-hour grace, a leader writing 1 MiB through its
grace exits on its own, and `terminate-after-leader` kills a member with closed stdio without
signalling it first.
