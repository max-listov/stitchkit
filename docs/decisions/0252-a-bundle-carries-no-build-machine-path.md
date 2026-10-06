---
title: "ADR 0252: A bundle carries no build-machine path"
description: "The default Darwin loader locates itself through module.filename, never __dirname, and refuses inside a bundle with a named stage; the package declares no import side effects; embedded native packaging names no output layout."
type: decision
status: accepted
created: 2026-10-06
updated: 2026-10-06
---

# ADR 0252 — A bundle carries no build-machine path

**Invariants:** I7, I8, I13, I14. Amends ADR 0235 (decisions 1 and 3) and ADR 0233 (embedded inputs).

## Context

ADR 0235 made the default Darwin loader compute its addon path at run time,
`require(__dirname + '/native/darwin-<arch>.node')`, so a bundler would not follow it. It did not
follow it, but Bun inlines `__dirname` and `__filename` of a bundled CommonJS module as string
literals. Every bundle and compiled executable built from `stitchkit/files`, `stitchkit/server` or
`stitchkit/process` without the packaging plugin therefore carried the absolute path of the package
on the build machine: the builder's user name, directory layout and install hash went out with a
distributed artifact, and on another Mac the loader looked for the addon at that foreign path.
The failure surfaced only on macOS, and only at the first call that needed the addon.

Two further costs sat on the same path. Every chunk of the package was assumed to have import side
effects, so a bundle that took only the managed file boundary from `stitchkit/files` still carried
the lock, process identity and the Darwin loader, and had to decide about native packaging for an
addon it never loads. And the embedded form of `createNativePackaging` required `entryPath` and
`assetPath`, which change nothing in a compiled executable, so callers invented values to pass the
schema.

## Decision

1. **The default loader locates itself through `module.filename`.** It never reads `__dirname` or
   `__filename`. Run from the installed package, `module.filename` is the loader's absolute path and
   the addon is loaded beside it, exactly as before. Inside a bundle it is not an absolute path (Bun
   rewrites it to a relative name; a module wrapper that does not provide it leaves it undefined), so
   the loader requires nothing and
   throws `STITCHKIT_NATIVE_NOT_PACKAGED`, whose message names `createNativePackaging`. No path of the
   build machine becomes a literal of the artifact. This replaces decision 1 of ADR 0235.
2. **An unpackaged bundle is its own failure stage.** The Darwin backend reports `unavailable` with
   stage `packaging` and that native code, separate from `resolve` (an installed addon that is
   missing) and `load`. This replaces the "not found beside the original package files" wording of
   decision 3 of ADR 0235; the rest of that decision stands: the packaging plugin is the only way an
   addon enters an artifact, and an unavailable backend is never evidence that an owner died.
3. **The package declares `"sideEffects": false`.** No module of `stitchkit` acts on import, so a
   bundler may drop what a consumer does not use; a bundle of the managed file boundary carries no
   Darwin loader. A module that needs an import side effect is a defect of that module, not a reason
   to withdraw the declaration.
4. **Embedded packaging names no layout.** `delivery: 'embedded'` takes `platform`, one
   `architecture` and `delivery`; a path is refused by the type and by a strict schema rather than
   ignored. Its asset is `bytes`, `size` and `sha256`, without `outputPath`. Companion delivery keeps
   its inputs. This amends the embedded inputs of ADR 0233.

## Rejected alternatives

- **A separate `stitchkit/files/boundary` leaf** for consumers that need only the boundary. It adds
  a second import path for names `stitchkit/files` already exports, and leaves every other partial
  import (`stitchkit/server` without a lock, for one) with the same dead weight. The side-effect
  declaration fixes the cause for all of them.
- **Detect a bundle by comparing `__dirname` with something known.** Inside a bundle `__dirname` is
  a valid-looking absolute path; reading it is exactly what puts the path into the artifact.
- **A build-time warning when the loader enters an unpackaged bundle.** Only a plugin can see the
  build, and a build without the plugin is the case to detect; the named runtime refusal and the
  documented artifact check cover it without a second mechanism. (Amended by ADR 0254: the check is
  `inspectNativeArtifact`, which reads a loader marker; the error code alone is in every bundle with a
  lock and proves nothing.)
- **Keep `entryPath`/`assetPath` optional for embedded delivery and ignore them.** An accepted input
  that does nothing is the confusion being removed.

## Consequences

- An artifact built without the plugin by 0.105.0–0.106.1 must be rebuilt to drop the build path.
- An embedded build drops its two paths; the migration is in `docs/guide/upgrading.md` (0.107.0).
- `tests/portable-entrypoints-bundle.test.ts` proves on Linux that lock bundles (Bun and Node
  targets) and a compiled executable contain no absolute path of the package in latin1 or UTF-16LE,
  that a boundary-only bundle contains no Darwin loader, and, as a negative control, that a loader
  reading `__dirname` does put the path into a bundle. Loading the addon from an installed package
  and from a packaged artifact remains qualified by the Darwin lanes.
