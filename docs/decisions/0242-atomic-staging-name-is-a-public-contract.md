# 0242 — The staging name of an atomic write is a public contract

**Status:** Accepted
**Date:** 2026-10-05

Invariants I8 and I14.

## Context

An atomic write stages its bytes in a file beside the target and renames or links it onto the
target. A process killed between the exclusive create and the publication (SIGKILL, OOM, power loss)
leaves the staging file in the target's directory. No later write removes it: the name is random,
so nothing but its age tells an abandoned staging file from a write in flight, and only the caller
knows how long its writes can take.

A consumer that keeps a directory of its own records must then tell the staging files apart from
its records. Without a public way to do that, a consuming project copied the internal name form into
its own pattern. One abandoned staging file in a registry directory made it refuse every later
operation until a person deleted the file, and every change of the internal form would have broken
that copy again without notice.

The writers did not even agree on one form: the atomic file writer, the chunk spool and the
contained write of the agent runtime each built their own staging name.

## Decision

Every staged file of an atomic write is named `.stitchkit-<24 lowercase hex>.tmp`. One module,
`packages/core/src/internal/atomic-staging.ts`, owns the form: the name generator and the predicate
are built from the same constants, and every writer takes its staging name from it —
`writeFileAtomic`, `writeFileAtomicSync`, the managed writer, the file state store, the directory
inbox, the chunk spool and the contained write.

`stitchkit/files` exports the predicate `isAtomicStagingName(name)` and the sweep
`sweepAtomicStaging({ directory, olderThanMs, signal })`. The sweep removes only regular files that
match the predicate and are older than the required `olderThanMs`; it never follows a symlink and
never enters a subdirectory, and it returns the names it removed. Recognising and sweeping abandoned
staging is the caller's responsibility, stated in the `writeFileAtomic` documentation.

The name form is a stable contract of `stitchkit/files`: changing it is a breaking change, with a
changelog entry and a migration.

The staging file of an exclusive lock (`.lock-<uuid>.tmp`) is not an atomic-write staging file. It
carries an owner record, the lock removes it by that owner's liveness, and an age-only sweep must not
touch it, so it keeps its own form and does not match the predicate.

## Reason and verification

A name a consumer has to match is part of the interface whether or not it is documented; the only
choice is whether it changes silently. Publishing the predicate moves the match into the library,
next to the writer, so a change of the form changes both.

`packages/core/tests/files-atomic-staging.test.ts` kills a real `writeFileAtomic` and
`writeFileAtomicSync` call between staging and publication (`tests/fixtures/atomic-staging-crash.ts`)
and observes the managed writer's staging file while it is filled. It checks that the predicate
accepts those names, pins the published form literally, rejects lookalikes and the published target,
and that the sweep leaves young files, symlinks, directories and nested files.
