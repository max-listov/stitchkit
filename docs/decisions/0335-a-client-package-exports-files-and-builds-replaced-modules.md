---
title: "ADR 0335: A client package exports files by subpath and builds replaced modules from given contents"
description: "`buildClientPackage` writes the archive's own manifest and named packed files into `exports` and proves each resolves by the package name, builds a module from contents the caller gives instead of its file and refuses a replacement nothing imports, and builds its entries with `Bun.build` from a script it runs in the same bounded `bun`, because the command line takes no plugin."
type: decision
status: accepted
amends: ["0331"]
created: 2026-11-28
updated: 2026-11-28
---

# ADR 0335: A client package exports files by subpath and builds replaced modules from given contents

**Relations:** Amends [ADR 0331](0331-a-client-package-is-one-module-graph-proven-installed.md) (its one-build clause: the build is now `Bun.build`, not the command line) and applies [ADR 0122](0122-optional-peer-surfaces-are-proven-from-artifacts.md) (proof from the packed artifact) and [ADR 0199](0199-one-owner-per-name-and-one-way-per-job.md) (one way per job).

## Context

A consuming project could not move its client package to `buildClientPackage`. Its package needs
three things the options did not have, and the package breaks for its consumers without any one of
them:

1. **`./package.json` in `exports`.** A consumer takes the client's version as the revision of a
   service descriptor: `import { version } from '<client>/package.json'`. With `exports` present,
   a subpath it does not list is refused by Node and Bun, and `manifest` refuses `exports` as a
   field the build writes.
2. **A data file by subpath.** A stream profile is read by its subpath name. `files` packed the
   file, and nothing made it importable.
3. **A module built from other contents.** The client's version module imports the project's own
   `package.json` for one field. Bundled from the file, the client ships the project's `scripts`
   and `devDependencies` — measured: the bundle carries the whole object. The project's own build
   replaced the module with a bundler plugin; `buildClientPackage` ran `bun build` on the command
   line, which takes no plugin, and had no other way in.

## Decision

1. **Files a consumer imports are declared, not inferred.** `exportedFiles` lists subpaths:
   `'./package.json'` is the archive's own manifest, any other names a path in `files`. Each is
   written to `exports` as a plain path. A subpath that names neither, or that an entry or another
   file already has, is a caller mistake (`TypeError`). Exporting every packed file would make a
   README importable and a licence a public subpath.
2. **The proof covers them like the entries.** In every runtime that imports the entries, each
   exported file is resolved by the package name and must land on its packed path; a `.json` file
   is imported with `with { type: 'json' }`, and its `default` is reported in `exports`. The strict
   consumer imports each JSON file the same way under Bundler and NodeNext, with
   `resolveJsonModule`. A JSON default is not compared with the entries' shared names: two data
   files are different values on purpose.
3. **A replacement is contents, not a plugin.** `replaceModules` maps a path, resolved like an
   entry, to the contents the bundler loads for it, read by the loader of that file's extension.
   Contents cross into the bundler process as data; a plugin is a function and does not. A
   replacement no bundled module imports is refused as `replacement-unused`, so a stale entry
   cannot claim the package was built from something it was not. Declarations are still emitted
   from the files themselves; the replacement keeps the shape the types describe.
4. **One build, through `Bun.build`.** The bundler's command line has no plugin flag, so the build
   writes a script that calls `Bun.build` with the options the command line spelled — entries,
   root, target, ESM, splitting, externals, entry and chunk naming, the tsconfig and a metafile —
   and runs it with the same bounded `bun`. There is one path with and without replacements; the
   metafile it writes is the one `readClientBuildGraph` already reads, and the package build keeps
   running from Node.

## Consequences

- The consuming project can delete its own client build and declaration scripts; its version
  module keeps importing the manifest, and the call replaces it.
- A bundler failure is reported from the script's log, under the same `build` reason and `output`.
- `missing-export` also covers an exported file that does not resolve to its packed path.
- The consumer lane's `client-package` proof exports the archive's manifest and a data file and
  typechecks a consumer that reads both.
- Not decided here: bundler plugins as an option. A plugin would have to be a module path the
  script imports, and no consumer has needed more than contents.
