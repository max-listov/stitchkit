# 0251 — A release does not wait for its consumers

**Status:** Accepted
**Date:** 2026-10-06

Practice. Invariant P. Supersedes [ADR 0250](0250-a-release-that-changes-process-behaviour-is-tried-on-the-consumers-before-its-tag.md).

## Context

ADR 0250 made `release:train` refuse a breaking or process-contract release until the tests of
the owner's own consuming projects had passed on the packed candidate. The gate needed a list of
those projects, their checkouts and their test commands, kept in a profile on one machine, because
a public repository does not name private projects (ADR 0164).

A gate that names consumers is only as strong as what its record binds. The record was keyed by the
framework tree and the toolchain; it did not bind the profile, the consumers' commits, their test
commands or the tarball, so a changed profile still satisfied it. Binding all of that makes the
record honest, and it also makes the framework's release depend on the state of private projects
on one machine. That is the wrong direction of dependency: a library is released on evidence it
owns, and a project that uses it owns the proof that an upgrade works for it.

## Decision

**The framework releases on its own evidence, and a consumer proves an upgrade on its own side.**

- `release:train` checks release metadata, the tagged head and the green exact-SHA CI run. It has no
  consumer check, no consumer profile and no waiver field.
- The repository contains no tool that runs a consumer's tests.
- The framework's own consumer is the packed consumer lane, a fixture inside this repository that
  installs the packed tarball and exercises the public surface, `stitchkit/process` included.
- A project that depends on `stitchkit` pins a version and tries a new one in its own CI before it
  moves the pin. A behaviour change reaches it as a documented entry in the changelog
  (`### ⚠️ Breaking changes` and the upgrade plan), which is the framework's side of the contract.

## Consequences

- A release that breaks a project is found by that project when it upgrades, not before the tag.
  The fix is a patch release; pinned versions limit the exposure to the project that chose to move.
- A behaviour a consumer relies on and no framework lane covers is a missing lane here. It becomes
  a fixture in the packed consumer lane, in public terms and without naming the project.
- No machine configuration is needed to release.

## Verification

`scripts/release-tagging.test.ts`: the tag step runs after the CI proof and before any tag or push,
and takes no consumer input.
