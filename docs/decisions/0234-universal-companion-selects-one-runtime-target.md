---
title: Universal companion selects one runtime target
description: One plugin and runtime loader for a JS artifact with several Darwin addons.
status: active
created: 2026-10-04 22:33 +07:00
updated: 2026-10-04 22:33 +07:00
type: decision
---

# A universal companion selects one runtime architecture

## Context

One JS artifact can serve Darwin arm64, x64 and Linux. Two single-target plugins
compete for one owning loader: the first onLoad replaces the file entirely.
A cross-build does not prove that the native identity works on another architecture.

## Decision

The existing `createNativePackaging` accepts an architecture array and an exact
assetPath map for companion delivery. The single-target string input and its result
type are kept; embedded compile accepts one architecture. One metadata graph and
generator create one lazy loader. At runtime only the matching process.arch is
selected, with no attempt at another addon on failure. Before any package IO the
uniqueness of targets, the completeness of the map, traversal and the intersections
of all output paths are checked. Packaging stays build-only and adds no peers.

## Verification and consequences

Qualification builds one archive from both native addons. Both real Darwin runners
download this shared artifact, check the source hashes and execute the same JS SHA
through Node and Bun offline. Self/child identity, live-owner refusal, dead-owner
recovery, a missing selected addon and a substituted opposite addon with a valid
counterpart kept are checked. The single-target negative control must show the exact
reason, an unsupported loader architecture. Linux executes the same bundle with the
Darwin addons removed.

The owning fixture changes the metadata, the package import map, the loader and both
addon paths; the consumer recipe does not change. The integrity digest does not
replace the application's signature/trust. CI evidence requires the shared build and
both native execution cells before the release tarballs are built and published.
An unverified architecture does not become supported because it was built on another
machine.

Invariants I8, I13, I14.
