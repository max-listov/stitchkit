---
title: Native libraries separate install and import closure
description: Neutral public imports may be bundled into a library without making the backend kernel a runtime dependency.
status: active
created: 2026-10-02 00:07 +07:00
updated: 2026-10-02 00:07 +07:00
type: decision
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-10-02 00:07 +07:00
---

# Native libraries separate install and import closure

**Invariants:** I7, I8, I13.

`stitchkit/files`, `stitchkit/primitives` and `stitchkit/process` have neutral import closures.
Installing `stitchkit` still installs the complete package and its declared dependency `ky`.
An import graph is not an installation graph; tree shaking does not change a package manifest.

A library that promises a Zod-only runtime can bundle these public imports during its build,
keep Zod external, and include the reachable declarations from the same published artifact.
It publishes its own library contract; no handwritten copy of a filesystem or process owner is
maintained. The build dependency remains the complete Stitchkit package. An independent
transition-reader entry can remain Zod-only because it imports no native implementation.

The qualification packs that derived library and installs it outside the authoring tree.
Bun and Node execute canonical JSON, durable no-replace publication, exclusive locking,
process evidence and leader settlement there without Stitchkit or ky installed. TypeScript
checks the declarations without a type import back into Stitchkit. The negative control fails
when an unbundled `stitchkit/files` import is used in the same consumer.

Darwin bundles also carry the native binaries from the published artifact at the loader's
relative location. The real Darwin x64/arm64 packed lanes qualify this path; fixtures on Linux
do not stand in for Darwin execution.

This is a qualified delivery composition, not an independently versioned primitive package.
No second package identity, source implementation or release authority is introduced.
See [native IO](../guide/native-io.md#libraries-with-a-zod-only-runtime).
