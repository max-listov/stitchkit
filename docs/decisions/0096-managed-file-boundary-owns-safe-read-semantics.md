---
title: "ADR 0096: Managed file boundaries own safe read semantics"
description: Root bootstrap, bounded inspection and caller-safe file errors are one portable boundary contract.
type: decision
status: accepted
created: 2026-08-21
updated: 2026-08-21
---

# ADR 0096 — Managed file boundaries own safe read semantics

## Context

ADR 0088 unified containment and writes, but applications still created the
root separately, read inspection was asymmetric, and expected filesystem
failures could surface as generic internal errors or leak host details through
different adapters.

## Decision

`createManagedFileBoundary({ createRoot: true })` may create exactly the final
root directory, non-recursively and with private permissions, beneath an
already-existing trusted parent. The default still requires an existing root.
Canonical containment and root symlink policy are unchanged.

The same bounded inspector runs for reads and writes, receives only the
configured prefix plus a caller/deadline signal, and cannot replace
framework-owned path or measured size. `inspectionTimeoutMs` bounds a
non-cooperative inspector from the caller's perspective. Read inspection gets
an isolated prefix copy, so an untrusted inspector cannot mutate returned file
bytes.

Expected managed-file failures use the published `FILE_*` registry and one
safe status adapter across typed tools, raw mounts and batch view results.
Unknown I/O causes are logged through canonical normalization and exposed only
as `INTERNAL_SERVER_ERROR`; physical roots and derived host paths never enter a
caller-facing value.

## Consequences

- Applications can opt into safe root ownership without a separate bootstrap
  helper or recursive directory creation.
- Read and write policy cannot drift.
- Exhaustive `StitchErrorCode` consumers must accept the expanded safe file
  code set, and raw native error text now includes its stable code.
