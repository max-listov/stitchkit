---
title: "ADR 0088: Managed files bind one application-owned root"
description: Portable Bun/Node file operations use canonical relative refs, opened-handle reads and atomic sibling-temp commits.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0088 — Managed files bind one application-owned root

## Context

View, download and upload had different containment, size and write semantics.
Passing absolute host paths through tools also leaked deployment layout and made
security fixes application-specific.

## Decision

`createManagedFileBoundary` asynchronously resolves one existing directory and
returns the only read/write capability. Public paths are canonical POSIX-style
relative paths validated by `ManagedFilePathSchema`; results are neutral
`ManagedFileRefSchema` values. The physical root never enters transport output.

Read resolves and contains pre-existing symlinks, opens with `O_NOFOLLOW`, checks
the opened handle is a regular file and enforces its cap while reading. Write
uses an exclusive same-directory `.stitchkit-<uuid>.tmp` file with mode `0600`,
measures a byte/abort budget while streaming, optionally inspects bounded leading
bytes, then commits. Default `replace:false` uses hard-link creation so an
existing target is never replaced; `replace:true` uses same-filesystem rename.
`durable:true` syncs file contents before the atomic visibility cutover.

`O_NOFOLLOW` is applied where the host exposes it. Windows is not currently a
supported security target for this boundary: its filesystem constants and
reserved/trailing-name rules differ, and `ManagedFilePathSchema` deliberately
does not claim to reject names such as `CON`, `NUL` or a trailing dot/space.
Containment still uses canonical `realpath` plus root membership, but Windows
support requires a separate threat-model decision and conformance lane.

Portable Node/Bun APIs cannot make every path component descriptor-relative.
The supported threat model therefore covers untrusted input and pre-existing
symlinks under a root exclusively controlled by the application or trusted OS
actor. A hostile actor concurrently replacing directories is outside this
portable guarantee and would require a platform-specific `openat`-class mode.
Caught failures attempt temp cleanup; recognizable debris may remain after a
process crash or cleanup failure and is observable through `onCleanupError`.

Managed view/download/upload use this boundary. `serveFile`, multipart storage,
retention and provider/domain artifact state retain their existing owners.

## Consequences

- Download writes stream to disk instead of buffering its full limit and returns
  a relative ref. Upload callbacks receive bounded bytes/ref, never an arbitrary
  reopenable path.
- Inspector output cannot replace measured size or canonical path.
- Atomic visibility and crash durability are distinct, explicit guarantees.
- The filesystem capability lives in peer-free `stitchkit/files`; its schemas
  also live in the contract-safe entrypoint.
