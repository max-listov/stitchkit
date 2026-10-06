# 0246 — A native command stops what its leader left in the group by default

**Status:** Accepted, amended by [ADR 0248](0248-a-stopped-leader-settles-with-its-exit-and-a-command-may-join-the-callers-group.md)
**Date:** 2026-10-05

Builds on ADR 0224, ADR 0238 and ADR 0243. Invariants I8, I9 and I10.

## Context

`runNativeCommand` runs every command in a process group of its own. When the leader exits, the
processes it started without waiting for them are still members of that group. By default they
were left running: a shell's `cmd &`, a build tool's watcher or a test runner's worker outlived
the command that started it, and nothing in the caller's code said so. A helper that inherited
stdout or stderr also kept the command's pipes open, so the command did not complete until its
deadline. `descendants: 'terminate-after-leader'` already existed as the opt-in that stops them;
the coding shell declared it on every call.

API shape (I9 and [api-shape](../architecture/api-shape.md#no-silent-default-for-a-decision))
asks that a choice which changes what happens to someone's processes has a named, safe default.
Leaking processes silently is the unsafe side of this choice: the cost appears later, in another
place, as a held port, a lock or a pipe that never closes. Keeping a helper alive is the side a
caller can name.

## Decision

**`descendants` defaults to `'terminate-after-leader'`.** Once the leader has exited, the members
left in the command's group are stopped by the command's `stop` policy (ADR 0243) before the pipes
drain. `'leave'` stays as the explicit choice for a helper that must outlive the command while it
stays in the group.

**A real daemon is unaffected.** A daemon detaches into a session of its own with `setsid` (as
`daemon(3)` does), so it is no member of the command's group and no group signal reaches it. The
default stops only what the leader left behind inside the group it was given.

Within the package, no call needs `'leave'`: the coding shell, the sandbox launch and the release
scripts all want their leftovers stopped. The coding shell keeps its explicit
`'terminate-after-leader'`, since a coding command owning its descendants is part of that
profile's contract. Tests that exercise a helper holding the pipes after its leader exited declare
`'leave'`.

Changing a default is a break (ADR 0238): it ships as a breaking changelog item with a mechanical
migration, `descendants: 'leave'` on the commands whose helper must survive.

## Consequences

- A command no longer leaks the helpers it started, and no longer waits for a helper that holds
  its output pipe after the leader exited.
- A caller whose helper had to survive in the group adds `descendants: 'leave'`.
- A group outliving its host is still the supervisor's (ADR 0243); this default acts only while
  the host observes the leader's exit.

## Verification

`packages/core/tests/native-command-descendants.test.ts` runs the fixture leader
`native-cooperative-leader.mjs` in `exit-when-ready` mode, which exits 0 and leaves a group member
whose stdio is detached from the command: without `descendants` the member is killed after the
leader exits; with `descendants: 'leave'` it is still alive when the result resolves. The schema
test asserts the parsed default.
