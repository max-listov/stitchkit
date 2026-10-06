# 0250 — A release that changes process behaviour is tried on the consumers before its tag

**Status:** Superseded by [ADR 0251](0251-a-release-does-not-wait-for-its-consumers.md)
**Date:** 2026-10-06

Practice. Invariant P. Complements the release wave of ADR 0136: consumers are still migrated after
publication, but they are no longer the first to learn that a release breaks them.

## Context

The framework's own lanes (unit tests, the packed consumer lane, the starter lanes) contain what
this repository's authors thought to write. A consumer contains what its authors wrote. A process
default changed in one release (ADR 0246); a consuming project's stub started its helper with
`nohup … &`, which the new default stopped, and 46 of its tests failed. Every lane here was green,
because none of them contains that stub. The consumer found it after publication and spent hours
telling a changed contract from its own regression.

## Decision

**A release is tried on the controlled consumers, before its tag, when it can change behaviour they
rely on.** It is required when the train releases `stitchkit` and either its changelog entry has a
`### ⚠️ Breaking changes` section or a file under `packages/core/src/process/` (or the
`stitchkit/process` entrypoint) changed since the previous release. `bun run consumer-canary`:

1. takes the tarball CI built for the release commit: the `release-packages` artifact of its green
   exact-SHA push run, the file `release.yml` publishes. HEAD must be a clean checkout of that
   commit. A local pack (`--local`) or any file (`--tarball <path>`) can be tried for a first look,
   and neither is recorded: a local pack lacks the Darwin addons CI's macOS runners add, and three of
   a consumer's tests that read the native packaging failed on it for that reason alone;
2. clones each consumer's committed HEAD into a scratch directory, points `stitchkit` at the
   tarball through the manifest's `overrides` (workspaces included), installs, and runs the
   consumer's own test command;
3. judges a failure against the consumer's own pinned version: the same tests run on a second clone
   without the override, and only a test the candidate newly fails stops the release; a test red on
   both is listed as pre-existing;
4. on every consumer green, records the pass in the gate memo, keyed by the working tree's content
   and the toolchain; any failure prints the failing consumer and the names of its failing tests and
   exits non-zero.

`bun run release:train` refuses a required canary that has no record for the tree being tagged.
The check runs after the exact-SHA CI proof and before the first tag. The order of a release is
therefore: commit the release metadata, push `release/X.Y.Z`, wait for its CI, run the canary,
fast-forward master, tag.

**The consumers are not named here.** The list, with each consumer's checkout path and test
command, lives in a profile file on the releasing machine (`STITCHKIT_CONSUMER_CANARY_PROFILE`, or
`~/.config/stitchkit/consumer-canary.json`), because a public repository does not name private
projects (ADR 0164). A required canary with no profile is refused with that path, not skipped.

**A failure is a decision, not a veto.** A consumer fails because the release is wrong, or because
the release breaks it on purpose and the consumer has not been migrated yet. The second is the
ordinary breaking release. It is released by recording the reason in `release-train.json` as
`consumerCanaryWaiver` (at least twenty characters, committed with the release), naming the consumers
that fail and the migration that covers them; `release:train` prints it. A waiver makes the break
visible before the tag instead of after it.

## Consequences

- A release the canary requires needs one run of the consumers' tests on the releasing machine, from
  a few minutes to as long as their suites take, plus a second run of the failing tests' consumer
  without the candidate. A release it does not require pays nothing.
- A failing canary on an additive release is a defect to fix, not to waive.
- The record is per machine, like the other green gates; the machine that tags is the machine that
  ran the canary.
- A consumer's uncommitted work is not tried; its committed HEAD is.

## Verification

`scripts/consumer-canary.test.ts`: against a synthetic consumer (one committed test, pinned to a
tarball of its own) a candidate that keeps the contract passes and a candidate that breaks it fails
naming that test, the pair being the control; a test the consumer already fails on its pinned
version is listed as pre-existing and does not stop a release, while a test the candidate newly
fails does; only the tarball of a green exact-SHA run for a clean HEAD is a CI candidate; the
consumer's own checkout is untouched; an install failure fails with its output;
the override keeps the consumer's other overrides; a missing profile is refused with its path; the
requirement is decided by the breaking section or a process-contract change and by nothing else;
the tag step refuses a required canary with no record for the tree, accepts a record for that exact
tree and a committed waiver, and does not carry a record over to a changed tree.
`scripts/release-tagging.test.ts`: the check runs after the CI proof and before any tag or push.
