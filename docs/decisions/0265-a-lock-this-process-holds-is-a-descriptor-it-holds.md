---
title: "ADR 0265: A lock this process holds is a descriptor it holds"
description: "A lock record that names this very process is held only while a descriptor of this process is open on it; a process image replaced in place keeps its PID and start time, but not that descriptor."
type: decision
status: accepted
created: 2026-10-20 08:03 +07:00
updated: 2026-10-20 08:03 +07:00
---

# ADR 0265 — A lock this process holds is a descriptor it holds

**Invariants:** I8, I13. Amends [ADR 0210](0210-lock-owners-are-process-instances.md).

## Context

ADR 0210 identifies a lock owner by machine, boot, PID namespace and process start: a record
whose identity still matches a live process is held. That identity describes a process, not
the program running in it. `execve` replaces the program and keeps the PID, the namespace and
the kernel start time, and `bun --watch` restarts an application exactly that way on every
source change. A restart in the middle of an update leaves the lock the earlier image held,
the new image of the same PID finds a record that matches itself in every field, and the lock
stays held until the PID changes. On a watched development server this was measured as 127
images under one PID and 2 202 `LOCK_TIMEOUT` refusals of a state store over three and a half
hours, each one reading `liveness alive, identity matched`.

A token generated when the module loads would tell two images apart, and it would also tell
apart things that share one hold: a worker thread has its own module state, and a second copy
of the package bundled into the same process has its own. Each of them would read a live
holder's record as a previous image and take the lock from under it.

## Decision

A holder keeps the descriptor it created the lock with open until it releases (it has since
0.94; every record that carries a process identity was written that way). So a record that
names this very process with matching identity is held only while some descriptor of this
process is open on the lock file. The descriptor table belongs to the process — workers and
module copies share it — and close-on-exec descriptors, which is how Node and Bun open files,
do not survive an image replacement.

When the probe finds no such descriptor, the owner is gone (`identity: descriptor-closed`) and
the lock is reclaimed under the same guard as a dead PID. The probe proves its own listing:
it opens the lock file and counts the answer only when `/dev/fd` lists that fresh descriptor,
so a platform that lists a fixed few descriptors answers "unknown", never "nobody holds it".
A record that names another process is judged exactly as before.

## Consequences

A restarted image takes over the lock its predecessor left without waiting, and a hold taken by
any thread or module copy of the same process is never displaced
(`tests/exclusive-lock-process-image.test.ts`, which also restarts a real `bun --watch`
process). A simulated owner record of this process with nothing holding it is an abandoned
lock, so a test that needs a live owner in this process holds the lock rather than writing its
record. An image of another process that was replaced in place is still judged alive: this
process cannot see another process's descriptors without privileges it does not have on every
platform.
