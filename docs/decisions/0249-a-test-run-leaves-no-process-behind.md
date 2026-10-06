# 0249 — A test run leaves no process behind

**Status:** Accepted
**Date:** 2026-10-06

Practice. Invariant P.

## Context

Tests of the process primitives start real processes: leaders, members of their groups, holders
that left the group with `setsid`. A test that registers them in a list after its first assertion
leaks them when that assertion fails or the test times out first, and a runner stopped by a signal
leaks everything it had started. The suite stays green; the processes live on with `PPID=1`,
for days, on a developer machine and a CI runner. Nothing looked for them.

Finding them from what they look like does not work. A command started by `runNativeCommand` leads
a session and a process group of its own, has an empty environment (`envPolicy: 'declared-only'`),
and keeps only the working directory it inherited, which says nothing about whose test it was. A
holder may call `setsid` itself. A probe confirmed it: a test cut off by its timeout in the middle
of a stop's grace left its leader and member running, and neither a session id nor the environment
named them.

## Decision

**A test owns what it starts, from before it can exist.** `tests/support/process-reaper.ts` takes a
registration at the moment the test could still fail: a leader's group through
`onLeaderStarted: trackGroupLeader`, a child the test spawns itself by pid (`trackProcess`), and a
member that publishes its pid in a file by the file's path (`trackPidFile`, read when the test
ends). `reapAfterEachTest()` kills all of it in `afterEach`, which runs after a failure and after a
timeout, and when the runner receives SIGINT, SIGTERM or SIGHUP.

**The run is checked by who the kernel says was orphaned, not by what the process looks like.**
`bun run test` and `bun run consumer-lane` of the core package run under `scripts/test-leak-gate.ts`. The gate sets
`PR_SET_CHILD_SUBREAPER` on itself, so the kernel reparents every process whose parent died to the
gate instead of to init, whatever its session, group, environment or working directory. When the
command has exited, a live child of the gate that is not the command was left behind by it. The gate
waits up to three seconds for a member a test just stopped to disappear, then names the survivors,
kills them and fails the run even when every test passed. A runner killed with SIGKILL runs no
`afterEach`; the gate still sees what it left.

Linux only. Where the kernel cannot do it the gate runs the command unchecked and prints that the
leak check was not measurable, never that it passed.

## Consequences

- A test that starts a process outside the registered shapes fails the run until it registers it;
  the gate names the process and its command line.
- The subreaper adopts orphans for the length of the run, so a test cannot observe that a process
  was reparented to init. None does.
- Reaping by group id is only sound for `group: 'own'`; a `group: 'caller'` leader is tracked by
  pid, because its group is the runner's.

## Verification

`scripts/test-leak-gate.test.ts` runs the real gate as a child: a clean command keeps its exit
code and prints nothing; a member left behind is named, killed, and fails a green command; a holder
that left its session with `setsid` is found; a member that ends inside the settle window is not
reported; a failing command keeps its own code. The first two controls are the ones that can fail:
an empty report from a gate that never saw a leak proves nothing.
