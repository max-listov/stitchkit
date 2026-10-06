---
title: Public build-time native packaging
description: One native-asset graph and a lazy loader for a custom companion layout and embedded delivery.
status: active
created: 2026-10-04 18:29 +07:00
updated: 2026-10-05 20:12 +07:00
type: decision
---

# Public build-time packaging of native assets

## Context

A native capability must survive the build and the move of the application. An
installer that parses the loader's private import literals depends on the internal
layout, even while it checks hashes and the current addon loads successfully. An
ordinary JS bundle contains the companion assets; a Bun compiled executable embeds
the addon of its own architecture.

## Decision

`stitchkit/files/packaging` is an evolving build-only leaf. `createNativePackaging`
returns the version/target of the installed package, the output path, the verified bytes
and the published size and SHA256 of the addon, and a structurally typed Bun plugin
(amended by ADR 0241: the digest is published when the package is built and checked on
every call; amended by ADR 0252: embedded delivery names no output layout and its asset has no
output path). Its declarations
need neither the Bun runtime nor ambient types. One package-owned metadata graph and
generator create a lazy loader for package imports, a custom companion output and an
embedded compile. Runtime leaves do not import packaging. The companion recipe
requires a fixed entry path without splitting; the relative addon edge stays
external for the bundler. The embedded mode passes the real addon to Bun compile.
An unsupported target and a missing asset have an explicit refusal; damaged metadata
and other IO failures throw. A consumer does not parse the private loader text.

## Consequences

The application chooses the archive format, the storage root, the signature/trust
and the install policy. It keeps the complete output graph and compares the source
hashes after an archive roundtrip. Equal digests confirm integrity, not
authenticity. A lost or corrupted runtime addon keeps its unavailable identity and
safe diagnostics; packaging does not invent process evidence and does not weaken the
guards. Maturity stays evolving until the public contract is qualified by two
independent consumers.

Invariants I7, I8, I13, I14. Qualification changes the private addon paths while
keeping the metadata, checks the refusal of the earlier hardcoded recipe and the
success of the public recipe, then executes the archived artifacts on the matching
Darwin runtime. Portable checks do not replace Darwin.
