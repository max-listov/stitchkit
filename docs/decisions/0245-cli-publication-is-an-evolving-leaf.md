# 0245 — CLI publication is an evolving leaf, not part of the stable CLI

**Status:** Accepted
**Date:** 2026-10-05

Builds on ADR 0198, ADR 0230 and ADR 0238. Invariants I8, I11 and I14.

## Context

`stitchkit/cli` is stable: a consumer builds a command-line program on it and expects to read the
changelog rarely. ADR 0230 added `publishCli` to that entrypoint — about 900 lines of release
infrastructure that build every target, commit an immutable version directory and move the public
manifest last, with its own lock, staging, retention and recovery rules.

That part of the entrypoint does not behave like the rest of it. It shipped in 0.104.0, and the
very next batch already changed how it treats staging left by a dead publisher and how often it
decompresses stored versions. Its limits, retention and staging hygiene are still being found
from real distributions. The stable promise covers the whole entrypoint, so either each such
change spends the stable budget of ADR 0198 and needs its own ADR, or the shape is held still while
it is still wrong. Neither is what a stable entrypoint is for.

`PRINCIPLES.md` also draws a boundary here: stitchkit carries no deploy infrastructure. Publishing
a distribution directory sits next to that line. What a CLI program needs at run time — the
manifest and target contract, signatures, the installer and the updater — is the wire contract
between a binary and its distribution, and it does not move with the publisher.

## Decision

**`publishCli`, `CliPublicationOptions`, `CliPublicationPhase` and `CliPublicationResult` move to
a new entrypoint, `stitchkit/cli/publish`, which starts evolving.** `stitchkit/cli` no longer
exports them, under no alias and with no re-export: the move is one cutover, as ADR 0238 requires.

What stays in `stitchkit/cli` is everything a running binary and its distribution share:
`CliBuildManifestSchema` and the asset, target and stamp schemas, `assertCliPublishable`,
`signCliManifest` / `verifyCliManifest`, `renderCliInstaller`, `checkCliUpdate`, `applyCliUpdate`
and `rollbackCliUpdate`. The publisher reads and writes that contract; it does not own it.

This is not a demotion. ADR 0198 forbids taking a stable promise back on a usage count, and none
is used here: `stitchkit/cli` stays stable, and the names leave it because their shape is still
being found, which is the definition of evolving in ADR 0103. Breaking `stitchkit/cli` to make
the move is itself a stable break under ADR 0198 and is cited as such.

Promotion of `stitchkit/cli/publish` to stable follows ADR 0198 like any other entrypoint: two
independent consumers and its own ADR.

## Consequences

- A consumer of `publishCli` changes one import specifier; the call, its options and its result
  are unchanged.
- Changes to publication limits, staging and recovery no longer spend the stable budget, and a
  reader of `stitchkit/cli` breaking entries no longer has to read them.
- A CLI program that only runs, installs or updates never sees release infrastructure in its
  entrypoint.
- The publisher remains peer-free, as `stitchkit/cli` is; the consumer lane proves both its
  declarations and that `stitchkit/cli` no longer exports it.

## Alternatives considered

**Keep it in `stitchkit/cli` and spend the stable budget on each change.** The changelog of the
first week shows that would be most weeks, each with an ADR for a tuning change.

**Remove `publishCli` from the package.** It already reuses the manifest, signature, filesystem and
lock owners (ADR 0230); dropping it would push every consumer back to hand-written publication
around those same owners, which is the duplication ADR 0230 removed.
