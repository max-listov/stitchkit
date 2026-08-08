---
title: The starter template is the development workspace
description: Run the canonical starter directly and reserve generated copies for disposable consumer validation
type: decision
status: active
created: 2026-08-08
updated: 2026-08-08
---

# 0066 — The starter template is the development workspace

## Status

Accepted. Complements ADR 0060 and ADR 0061.

## Context

The starter needs two different guarantees. Contributors need ordinary HMR while
editing its source, while releases need proof that the published CLI produces a
self-contained external application. A persistent generated copy joined those
jobs with a file synchroniser, duplicated process configuration and allowed the
runtime copy to drift from the source under review.

Project-name substitution also spread identity placeholders through package
manifests, process names, tests, transport metadata and visible UI. This made the
template itself non-runnable and turned a cosmetic rename into framework logic.

## Decision

`packages/create-stitchkit/template` is both the canonical source and the live
development workspace. Its packages live under one `packages/*` namespace and
carry the neutral `stitchkit-starter` identity. `bun run starter:dev` launches
the backend and frontend directly through their PM2 entrypoints, so Bun and Next
watch the authored files without a copy or reconciliation layer.

The scaffolder performs a structural copy plus the required dotfile renames. It
does not rewrite project identity. Consumers rename the neutral application
explicitly when adopting it.

Exact generated-product verification remains mandatory, but only in temporary
directories owned by the target and HEAD starter lanes. Those fixtures use
isolated ports and isolated PostgreSQL databases and are removed after
successful runs.

## Consequences

- There is one persistent starter tree and one source of truth.
- HMR observes edits immediately through the same package layout users receive.
- The release lane, rather than a long-lived preview, proves scaffold fidelity.
- Renaming is visible product work instead of hidden global token substitution.
- Framework and starter dependency versions remain independently controlled as
  defined by ADR 0061.
