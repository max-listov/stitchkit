---
title: "ADR 0136: One exact tree drives a package-aware release train"
description: "Selected packages share one release commit and CI run; a target-aware DAG validates only distinct evidence and assembles immutable artifacts last."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0136 — One exact tree drives a package-aware release train

## Context

The repository publishes independent packages, but its release mechanics treated each tag as a
separate tree. Releasing two packages required two branch heads and two whole CI runs even when the
second commit changed only release bookkeeping. Inside each run the portable framework job waited
for Darwin binaries before beginning unrelated Linux work, both Darwin runners executed the whole
consumer suite to qualify one platform-specific fixture, and the starter ran target and HEAD modes
when their framework bytes were identical.

The guarantees are valuable; their accidental repetition is not. Evidence belongs to the bytes,
platform and compatibility edge it checks, not to the number of tags pushed afterwards.

## Decision

A release commit carries `release-train.json`, a versioned, validated list of package targets and
versions. Its subject is `release(train): …`; every selected package tag points at that one branch
head. The exact-SHA push CI produces the immutable tarballs consumed by all tag workflows.

One planner maps the train—or, for ordinary pushes, changed paths—onto named evidence lanes.
Portable package validation starts immediately. Darwin qualifies only the packed contained-files
surface under Bun and Node and uploads its architecture leaf. Artifact assembly is the only job
that waits for those leaves, and it packs only packages selected by the train. Starter releases
exercise the published-target edge; core releases exercise packed HEAD; the Cartesian product of
both modes remains a scheduled/manual full audit.

The local release gate uses the same target vocabulary and a bounded dependency DAG. Structural
lint, types, tests and builds precede dependent runtime lanes; independent heavy lanes run with a
maximum concurrency of two. Its memo key includes the selected target set in addition to the exact
tree, toolchain and external lane environment.

## Consequences

- Several packages publish from one reviewed tree, one CI result and independent idempotent tags.
- Platform proof remains real and packed, while unrelated portable work no longer sits behind it.
- Ordinary and package releases learn only distinct facts; nightly/manual CI retains exhaustive
  cross-product coverage and detects planner blind spots.
- Adding a package requires one target definition and its evidence mapping, rather than another
  copied release pipeline.

