---
title: "ADR 0135: Contained files use native Darwin directory capabilities"
description: "macOS file tools traverse pinned directories with a packaged Node-API openat backend instead of treating dev-fd names as directories."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0135 — Contained files use native Darwin directory capabilities

## Context

The Agent coding tools and harness resource reader must keep an authorized root, every ancestor
and the final effect attached to filesystem identity while application authorization awaits. Linux
can name an opened directory through `/proc/self/fd/<fd>/child`. macOS exposes an opened descriptor
at `/dev/fd/<fd>` for some identity operations but does not make that spelling a traversable
directory: opening a child returns `ENOENT` and listing returns `ENOTDIR` in both Bun and Node.

Returning to realpath plus an absolute child path would make positive calls work by restoring the
same parent-replacement race the descriptor boundary removed. A generic execution gateway or a
consumer-owned second file engine would also split direct tool identity and containment policy.

## Decision

Linux retains its `/proc/self/fd` backend. macOS loads one packaged, ABI-stable Node-API addon for
its architecture. The addon exposes only controlled single-segment `openat`, `fstatat`, `renameat`,
`unlinkat` and descriptor-directory enumeration operations. JavaScript continues to own bounds,
UTF-8 decoding, authorization, tool contracts, errors and traversal policy; the native leaf only
crosses the filesystem capability gap unavailable in Bun/Node's public JavaScript API.

Root opening compares path and descriptor identity once, then all descendants and mutations remain
relative to pinned descriptors. Temporary replacement is created and renamed inside the same
opened parent. Symlinks are inspected without following and are refused or skipped by the existing
collector policy. Unsupported platforms fail closed. FreeBSD is not inferred from Darwin and is
not claimed supported without its own backend and real platform lane.

CI builds arm64 and x64 Darwin binaries on real macOS runners, installs a packed consumer and runs
the same Bun and Node file/search/resource/race conformance. The Linux package job downloads both
validated binaries before producing the exact tarball consumed by release. A local Linux full gate
cannot manufacture real macOS evidence, so this platform qualification is an explicit CI-only
addition to the otherwise equivalent local gate.

## Consequences

- macOS coding and harness filesystem operations work without weakening parent-swap containment.
- The public package gains two small native files, but no install script, compiler requirement or
  new runtime dependency.
- Bun and Node share one Node-API binary per architecture and one JavaScript policy surface.
- A new operating system or architecture requires an explicit backend, packaged artifact and real
  packed-consumer lane; names such as `/dev/fd` are never treated as proof of semantics.
