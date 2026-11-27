---
title: "ADR 0331: A client package is one module graph, declared for both resolutions and proven installed"
description: "`buildClientPackage` builds every entry of a typed client in one pass with its peers outside, rewrites the emitted declarations with one tokenizer so they resolve under Bundler and NodeNext, and returns the archive only after it was installed into an empty directory and used there; `buildClientArtifact` stays the one self-contained file and no longer packs an archive."
type: decision
status: accepted
created: 2026-11-27
updated: 2026-11-27
---

# ADR 0331: A client package is one module graph, declared for both resolutions and proven installed

**Relations:** Extends [ADR 0233](0233-public-build-time-native-packaging.md) (the build-time packaging entrypoint) and applies [ADR 0122](0122-optional-peer-surfaces-are-proven-from-artifacts.md) (proof from the packed artifact), [ADR 0199](0199-one-owner-per-name-and-one-way-per-job.md) (one way per job), [ADR 0238](0238-pre-1-0-api-shape-outranks-compatibility.md) (a clean break before 1.0) and [ADR 0252](0252-a-bundle-carries-no-build-machine-path.md) (no build-machine path in an artifact).

## Context

`buildClientArtifact` builds one entry into one self-contained file: everything bundled, no
declarations, and an optional npm archive of that file. That is the right product for a client a
consumer copies. It is the wrong one for a client published to a registry, and three consuming
projects had each written 750–970 lines of build scripts to get from the first to the second.
Four things were missing, and each was measured before this decision:

1. **Several entries, one graph.** Two builds of two entries of one package give two module
   graphs. A schema and an error class exported by both were different objects in Node and in Bun:
   `===` and `instanceof` were false across the halves of one package. In one consuming project
   156 of 161 shared exports were split this way.
2. **Declarations a consumer can resolve.** The compiler writes a relative specifier into a
   declaration as the source wrote it. Extensionless specifiers typecheck under Bundler resolution
   and fail under NodeNext with `TS2834`; with `skipLibCheck` on, the failure is silent and the
   type becomes `any`. `rewriteRelativeImportExtensions` rewrites emitted JavaScript and leaves
   `.d.ts` alone. A `.js` specifier resolves under both resolutions in TypeScript 5.9, 6.0 and 7.0.
3. **Peers outside.** Bundling the contract layer and the validation library into a client
   duplicates them in every consumer and splits the identity of whatever the client re-exports.
4. **Proof of the package, not of a file.** The archive proof imported the package in Bun and
   checked names. It ran no Node, no consumer typecheck, installed no peer and compared nothing
   between entries.

## Decision

1. **Two products, two functions.** `buildClientPackage` is a sibling of `buildClientArtifact` in
   `stitchkit/files/packaging`. The file a consumer vendors bundles everything and has no
   declarations; the package from a registry keeps peers outside and must have declarations. One
   function with both would be a mode switch whose options only make sense in pairs.
   `buildClientArtifact` loses `package`: an archive of a client is made one way, and the old way
   bundled the peers. Its `executable` becomes `executables: { bun }`, the name its sibling uses.
2. **One build over all entries.** Every entry goes to one `bun build --splitting` with each peer
   and dependency `--external`; a module two entries import is emitted once, as a shared chunk.
   The build runs through the bounded command runner, so the function works from Node and Bun.
3. **The module graph is checked beyond the output.** `forbiddenModules` reads external imports
   too: a rule naming `pkg/server` refuses the import whether or not the code is bundled. A
   module whose real path lies inside a peer's directory is refused as `bundled-peer` — an import
   by path into a workspace neighbour bundles it despite `--external`.
4. **Declarations are emitted for the entries' graph and normalised.** A generated tsconfig
   extends the project's with `files` set to the entries, `emitDeclarationOnly` and
   `declarationMap: false`; it is written beside the project's own, because type roots are looked
   up from the config's directory, and removed afterwards. Every relative specifier is rewritten
   to the `.js` file it stands for; one with no declaration in the tree, and any
   `/// <reference path>`, is refused. Every bare specifier must be a peer, a dependency or a
   platform module, or the consumer could not resolve a public type.
5. **One tokenizer finds specifiers, and one rewrite uses it.** The compiler's parser is not a
   stable API across its major versions. A declaration file names modules in a few positional
   forms, so `files/declaration-specifiers.ts` tokenizes strings, comments and template literal
   types and reads a specifier by what precedes it. A test holds it to the compiler's parser over
   real declaration trees. The same module owns the rewrite of a declaration tree, and this
   package's own build (`scripts/rewrite-declaration-specifiers.mjs`) runs on it instead of a
   parser of its own: the two rewrites were compared on the full declaration tree of this package
   — 1094 files, 2402 specifiers rewritten in 784 of them — and the output is byte-identical.
6. **The archive is proven installed.** It is installed into an empty directory with each peer and
   dependency taken from where the build resolved it. Then: the installed files equal the built
   ones; each installed version satisfies its declared range; every subpath is imported by the
   package name in Node and Bun; a name exported by several subpaths is one value in all of them
   unless declared distinct; and a strict consumer with `skipLibCheck: false` typechecks under
   Bundler and NodeNext, with settings written as a tsconfig file because no flag spelling is
   shared by every compiler version. Any refusal removes the archive.
7. **A refusal is typed.** `ClientPackageError.reason` is a closed list and `details` names the
   file, specifier, package or names; a forbidden module stays `ForbiddenModuleError`.

## Consequences

- A consuming project replaces its build, declaration and verification scripts with one call;
  publishing and provenance remain its release.
- Callers of `buildClientArtifact({ package })` and `{ executable }` migrate; the entrypoint is
  evolving and the break is a minor.
- The build needs Bun and a `typescript` installed in the project; `typescript` is not a
  dependency of this package. The project's compiler is run by the runtime that runs the build.
- The proof installs transitive dependencies of the peers through the package manager, so it is
  hermetic only up to the peers themselves.
- A public type that names a package outside the peers and dependencies, a path alias, or a
  hand-written `.d.ts` beside the sources is refused rather than shipped unresolvable.
- The consumer lane builds a client of a contract from the packed framework, with the framework
  as its peer (`client-package`), in Bun and in Node.
- Not decided here: a CLI command over the same options.
