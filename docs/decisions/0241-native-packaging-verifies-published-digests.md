---
title: Native packaging verifies published digests
description: The package publishes the size and SHA256 of each Darwin addon at build time; createNativePackaging checks the installed bytes against them once and hands out those verified bytes.
status: active
created: 2026-10-05 20:12 +07:00
updated: 2026-10-05 20:59 +07:00
type: decision
---

# Native packaging verifies published digests

Amends ADR 0233: the source SHA256 of an asset is the digest the package published, not one
computed from the installed file. Invariants I8, I13, I14.

## Context

`createNativePackaging` returned a `sha256` per asset that it computed from the file currently in
`node_modules`. The package published no digest to compare it with, so the value described
whatever was installed: an addon substituted after installation received its own digest, and a
consumer that compared the bytes it copied with that digest compared the file with itself. The
asset also exposed `sourcePath`, so a consumer read the addon a second time to copy it, outside
any check, and a build that called `createNativePackaging` from several places read and hashed
both addons on every call. The only real integrity was the tarball hash in the consumer's
lockfile.

## Decision

1. **The package publishes the digest.** The tracked source layout is `native-layout.json`
   (loader and addon paths, build input only). `build` generates the published
   `native-assets.json` from it at `formatVersion: 2`, with `{ path, size, sha256 }` for every
   Darwin addon present at build time. A release is packed after both addons are in place and
   refuses a manifest without both digests. An architecture without an entry is not published.
2. **The reader refuses any other format.** `formatVersion` is a literal `2`; an older or newer
   manifest throws before any asset is read, like other damaged metadata.
3. **One read, verified, and a refusal that can be read.** Each selected addon is read once, and
   the size and SHA256 of the bytes read are compared with the manifest. A difference is the typed
   refusal `{ state: 'mismatch', code: 'NATIVE_ASSET_DIGEST_MISMATCH', architecture, expected,
   actual }`, beside `unsupported` and `missing`: `expected` is the published `{ size, sha256 }`
   and `actual` the installed file's, so a log tells a truncated copy from a substituted one
   without a second read. The bytes are hashed even when the size already differs; the read has
   been paid, and the hash is what identifies the file that was found. A universal request
   refuses as a whole, at the first differing addon.
4. **The platform is a closed set.** `platform` is `z.enum(['darwin'])`, the platforms the
   package publishes addons for. Another name is a type error and a schema refusal that throws;
   it is not an `unsupported` result, which names only an architecture without an addon. A free
   string promised platforms that do not exist; adding one is a deliberate widening of the enum.
5. **The verified bytes are the result.** A ready asset is `{ outputPath, size, sha256, bytes }`
   (plus `architecture` in the array form); `size` and `sha256` are the published values and
   `bytes` match them. `sourcePath` is not exposed. Embedded delivery gives Bun the same bytes
   through the plugin's `onLoad`, so the compiled executable carries what was checked even if the
   file changes afterwards.
6. **One call per build.** Every call reads and hashes the selected addons; the result (assets
   and plugin) is the value to reuse. There is no hidden cache: a second call is a second check.

## Consequences

A consumer writes `asset.bytes` and records `asset.sha256` in its own archive manifest; it no
longer re-hashes the installed addon. The digest binds the addon to the package Stitchkit built.
It does not authenticate the package: the tarball's integrity in the consumer's lockfile and any
signature policy stay with the application. The shape change is a recorded break of an evolving
entrypoint.

Verification: `packages/core/tests/native-packaging.test.ts` builds the packaging module into a
fixture package with synthetic addons and a published manifest; one changed byte and one extra
byte both refuse with the published and the installed size and SHA256, a platform other than
`darwin` throws (and is a `@ts-expect-error`), an unlisted architecture is missing, a `formatVersion: 1` manifest throws, and
an embedded build after the file was replaced still carries the verified bytes. On packed
packages, `scripts/universal-native-build.ts` refuses a manifest without both digests and proves
the tamper refusal with the real addons; the Darwin consumer lane
(`darwin-artifacts.mjs`) does the same before executing the artifacts.
