---
title: "ADR 0235: The default native loader is invisible to bundlers"
description: "The packaged Darwin loader names its addon by a computed path, so portable entrypoints bundle to one file on every OS; only the packaging plugin produces a static loader, and the packaging leaf stays as the one way to carry an addon."
type: decision
status: accepted
created: 2026-10-05
updated: 2026-10-05
---

# ADR 0235 — The default native loader is invisible to bundlers

## Context

`stitchkit/server`, `stitchkit/files` and `stitchkit/process` reach the Darwin process-identity
code through the exclusive lock. The packaged loader (`darwin-native.cjs`) required both
`.node` addons by literal path, so every Bun bundle of these entrypoints, on any operating system,
gained two Darwin addon outputs: `bun build --outfile` of a Linux server app failed with
`cannot write multiple output files without an output directory`. The portable entrypoints
carried a platform-native build-graph dependency, against I6 (the core stays portable) and
I7 (optional machinery stays leaf-isolated).

The static loader was added so compiled and companion artifacts carry the addon without help,
and the `stitchkit/files/packaging` plugin (ADR 0233, 0234) was built on the same loader.

## Decision

1. **The default loader computes its addon path** from its own directory at run time
   (`require(__dirname + '/native/darwin-<arch>.node')`). A bundler does not follow it: bundles of
   `server`, `files` and `process` are one JS file with no `.node` output on every OS. Run
   unbundled from the installed package, it loads the addon exactly as before.
   (Amended by ADR 0252: Bun inlines `__dirname` as the build machine's path, so the loader locates
   itself through `module.filename` and refuses inside a bundle with stage `packaging`.)
2. **Only the packaging plugin produces a static loader.** `createNativePackaging` replaces the
   loader's contents with one that requires the addon by literal path, which the bundler then embeds
   (`delivery: 'embedded'`) or leaves as a companion (`delivery: 'companion'`). One generator,
   `nativeLoaderSource(assets, resolution)`, writes both forms from the same asset graph.
3. **The packaging leaf stays, evolving, as the single way to carry an addon in an artifact.**
   Without it the Darwin backend of an unpackaged bundle is `unavailable` where the addon is not found
   beside the original package files, never evidence that an owner died. Nothing else in the
   package delivers a static loader, so there is no second path.
4. **Lock liveness on macOS keeps the addon-based process identity.** The packaging plugin is what
   makes that identity reachable from a bundled artifact.

## Rejected alternatives

- **Read process start time and boot session without an addon** (`sysctl kern.boottime`,
  `ps -o lstart=`) on the reclaim path, leaving the addon to contained files only. `lstart` has
  one-second resolution and a locale-dependent format, every reclaim spawns two processes, and the
  result is a second, unverifiable macOS implementation of the same evidence. It also would not
  remove the packaging need: the contained-file tools in `agent-runtime` need the addon too.
- **Remove the packaging leaf and its companion/universal recipes.** Consumers delivering Darwin
  artifacts would lose the only supported way to embed an addon, and the default loader would
  still need some route into a bundle.
- **Keep the static default and document it.** Every portable bundle would still carry Darwin
  assets and Linux `--outfile` builds would stay broken.

## Consequences

- A Darwin consumer that bundled or compiled these entrypoints and relied on automatic embedding
  builds with the plugin; this is a breaking change with a migration (`docs/guide/upgrading.md`).
- Linux and other portable bundles need no change.
- Darwin behavior (embedded, companion and universal artifacts, backend unavailable in an
  unpackaged bundle) is exercised only by the Darwin consumer lane and CI jobs; the Linux gates
  prove the bundle graph (one file, no `.node`) and the loader text.
