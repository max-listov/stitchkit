---
title: The official starter advances independently from framework HEAD
description: Pin the generated application to one validated Stitchkit catalog range and release the scaffolder on its own tag line
type: decision
status: active
created: 2026-08-08
updated: 2026-08-08
---

# 0061 — The official starter advances independently from framework HEAD

## Status

Accepted. Refines ADR 0060.

## Context

The official starter is a real application consumer, not another framework
package. Requiring its package version and dependency target to equal every
Stitchkit release couples unrelated work: a framework release would also publish
an unchanged scaffolder, while a breaking framework iteration could not finish
until the starter migrated in the same commit.

The public starter instead needs a stable, reproducible baseline. Compatibility
with framework HEAD remains useful information, but it must not silently change
what newly generated projects install.

## Decision

The canonical template is an autonomous Bun workspace with its own committed
lockfile. Its root `catalog.stitchkit` entry is the single source of the
published framework range; child workspaces reference it with `catalog:`.

`stitchkit` and `create-stitchkit` use independent package versions, changelogs
and tags. The static starter lane is authoritative for the generated product. A
separate HEAD lane replaces only a temporary generated catalog target with the
packed local core and reports compatibility drift. HEAD compatibility blocks a
scaffolder release, but never a framework release.

## Consequences

- Framework work and releases cannot move the public starter dependency.
- Advancing the starter is one explicit catalog edit plus a lockfile refresh.
- Generated applications receive the same catalog and resolved dependency graph
  that passed the static lane.
- A delayed starter migration is visible through the HEAD probe without forcing
  both packages into one version or release.
- `vX.Y.Z` releases `stitchkit`; `create-stitchkit-vX.Y.Z` releases the
  scaffolder.
