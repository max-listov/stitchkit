---
title: "ADR 0321 — A test run leaves no temporary file behind"
description: "Every test suite runs under the leak gate with --tmpdir: the gate gives the run a fresh, empty TMPDIR under /tmp, lists what is left in it once the command has exited, removes it, and fails the run when the list is not empty."
type: decision
status: accepted
amends: ["0249"]
created: 2026-11-24
updated: 2026-11-24
---

# ADR 0321 — A test run leaves no temporary file behind

Practice. Invariant P. Extends the gate of [ADR 0249](0249-a-test-run-leaves-no-process-behind.md)
from processes to temporary files, and from the core suite to every suite.

## Context

One developer machine held 514 `stitchkit-*` entries in `/tmp`, 290 MB, after a day of test runs.
Nothing in the suite looked for them, so every leak was green. Run one file at a time with its own
empty `TMPDIR`, the suites showed four ways a test leaves something behind:

- **No cleanup that runs.** Scratch directories made per test and never removed; a cleanup hooked
  on `process.on('exit')`, which the test runner does not fire; a test that removes the child it
  scaffolded into instead of the `mkdtemp` parent; a cleanup at the end of a test body, which a
  failing assertion skips.
- **A write the test did not wait for.** A spooled store marks a receipt delivered after the
  ledger took it, later than the test's own wait; the test removed the directory first, and the
  spool, which creates a missing directory rather than lose a row, recreated it.
- **A timer that outlives the test.** A directory inbox standing in for a process that died was
  only stuck: a quarter of its lease later its renewal wrote the state file and recreated the
  directory `afterEach` had removed. Run alone, the file ends before the timer fires; in a shard,
  where the process lives for minutes, it fires every time.
- **A shared directory used as a home.** A probe ran a Bun script with `HOME=$(tmpdir())`, and
  Bun keeps its transpiler cache in `$HOME/.bun`, so `/tmp/.bun` grew with every run.

A run that is killed leaves what its tests had open as well, whatever their cleanup.

## Decision

**Every suite runs under the leak gate with `--tmpdir`.** `scripts/test-leak-gate.ts --tmpdir --
<command>` makes a fresh directory `sk-run-XXXXXX` under `/tmp` (resolved, so `/private/tmp` on
macOS), mode `1777` like `/tmp` itself, and runs the command with `TMPDIR` pointing at it. Every
`tmpdir()`, every `mkdtemp` and every child process of the run lands there, whatever prefix it
chose. Once the command has exited and the process check is done, the gate lists what is left
directly in the directory — name, kind, entries of a directory — removes the directory, and fails
the run if the list is not empty. A failing command keeps its own exit code.

The package `test` scripts of `stitchkit`, `stitchkit-tui` and `create-stitchkit`, the repository
`scripts` suite of `bun run test` and of CI, and the load lane all call it.
`scripts/test-suites.test.ts` refuses a suite whose command does not.

The directory is short on purpose: tests bind unix sockets under `tmpdir()`, and a socket path has
104 bytes on macOS and 108 on Linux, while a macOS `tmpdir()` alone takes about fifty. It is as open
as `/tmp` because a test that drops privileges to prove a permission refusal must still reach its
own scratch directory under it.

There are no exceptions to the temporary-file check. Two script tests run it without the process
half (`--no-process-check`), as a suite of their own (`scripts orphans`, listed once in
`scripts/test-suites.ts`): `lane-processes` and `load-lane` prove that a lane's orphans die once
their parent is killed with `kill(pid, 0)`, and under a subreaper a dead orphan waits as the gate's
unreaped child, which that probe still finds; both files failed under the full gate and passed
without it. Every other script test passed under the whole gate and keeps it. The consumer lane runs under the
gate without `--tmpdir`: on a failure it keeps its work directory for inspection on purpose, and
says where.

A test removes what it made in `afterEach` or a `finally`, waits for the writes of what it started,
stops a resource it left running, and gives a child a home of its own.

## Consequences

- A leak fails the run that introduced it, named by its prefix, instead of accumulating; the
  same applies to what a killed test runner left, as long as the gate itself survives.
- A test that writes to a literal `/tmp` escapes the check; a fixture that did was moved to
  `tmpdir()`.
- The half of the gate that checks processes stays Linux-only; this half runs everywhere.

## Verification

`scripts/test-leak-gate.test.ts` runs the real gate with `--tmpdir`: a clean command sees an empty
directory of its own with mode `1777` that is gone afterwards; a green command that leaves a
directory and a file fails with both named and the directory removed; a failing command keeps its
code. The second control is the one that can fail. Before the fixes, the gate failed the
pre-fix copies of `tests/cli-in-process-stream.test.ts` (5 entries) and
`tests/observability-changes-and-spool.test.ts` (9 entries) while every test passed.
