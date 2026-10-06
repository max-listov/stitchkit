---
title: "ADR 0254: A packaging plugin owns one loader and names what it finds"
description: "Generated Darwin loaders carry a marker that inspectNativeArtifact reads to classify an artifact as packaged, unpackaged or loader-free; the packaging plugin fails a build that carries another installation's loader."
type: decision
status: accepted
created: 2026-10-06
updated: 2026-10-06
---

# ADR 0254 — A packaging plugin owns one loader and names what it finds

**Invariants:** I8, I13, I14. Amends ADR 0252 (the artifact check).

## Context

ADR 0252 documented an artifact check: search the bytes for `STITCHKIT_NATIVE_NOT_PACKAGED`. That
string is also the error code `darwin-binding-error` exports, and every bundle that reaches a lock
or process identity carries it — exactly the bundles that need the addon. A consumer measured a
correctly packaged bundle on macOS: one occurrence, backend `observed`. The documented check would
have refused every correct build.

The same consumer found a build that a packaging plugin let through broken. The plugin replaced
only its own installation's loader; an entry that imported another `stitchkit` (a build tool's own
copy, another version or the same version under another path) kept that installation's default
loader. The build succeeded, the plugin wrote its addon, and the artifact refused it at run time
with a message telling the author to use the plugin they had used.

## Decision

1. **Every generated loader carries a marker.** `nativeLoaderSource` ends each loader with
   `module.exports.stitchkitNativeLoader = 'stitchkit-native-loader:packaged'` (the static loader)
   or `…:unpackaged` (the default one). A property assignment survives minification; no other
   module carries the marker as one literal (it is joined at run time).
2. **`inspectNativeArtifact(bytes)` is the check.** It reads both markers in latin1 and UTF-16LE and
   answers `unpackaged`, `packaged` or `no-loader`, in that order of precedence. Documentation names
   the function, not a string search.
3. **The plugin owns one loader.** A default loader of any other installation — recognised by its
   published name and the `package.json` beside it, never by its text — fails the build with an
   error naming both versions and roots and the fix. Companion and embedded delivery alike.

## Consequences

- Artifacts built by 0.107.0 or earlier carry no marker and read `no-loader`.
- A build that bundled another installation's loader, which already failed on macOS at run time,
  now fails at build time.
- `tests/native-packaging.test.ts` builds two foreign installations (another version, and the same
  version at another path) under companion and embedded plugins, and classifies packaged, minified,
  unpackaged and loader-free artifacts, with the bare error code as a negative control.
