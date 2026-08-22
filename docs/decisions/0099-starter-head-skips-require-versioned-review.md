---
title: Starter HEAD skips require an exact-version deferred review
description: Make packed HEAD the fail-closed default while retaining an explicit bridge for genuinely incompatible breaking releases
type: decision
status: active
created: 2026-08-23
updated: 2026-08-23
---

# 0099 — Starter HEAD skips require an exact-version deferred review

## Status

Accepted. Refines ADR 0061.

## Context

ADR 0061 keeps the published starter target independent from framework HEAD.
The later breaking-release bridge inferred a HEAD skip solely from a breaking
changelog heading and mismatched pre-1.0 minors. Several consecutive breaking
releases could therefore leave the template untested against HEAD; its first
additive successor inherited the delayed failure.

A hard cut can still make one template source unable to compile against both
the published target and the unpublished core. Removing the bridge entirely
would recreate the release cycle ADR 0061 avoided.

## Decision

Packed local-HEAD validation is fail-closed: it runs for additive, aligned and
unaligned breaking releases. An unaligned breaking release may skip it only
when `scripts/starter-head-review.json` names the exact core version, uses the
literal outcome `deferred`, and records a non-empty reason. Missing, stale and
unknown records run HEAD; invalid JSON refuses the release-plan command.

CI and pre-push use the same decision. Target validation is never skipped, and
the HEAD lane continues to install a locally packed core rather than querying
npm for an unpublished version.

## Consequences

- A new breaking SHA exposes starter drift immediately unless somebody records
  the incompatibility debt deliberately.
- A genuine dual-version source conflict remains releasable without aliases or
  compatibility wrappers.
- Review records cannot silently carry into another core version and are
  removed when the starter target advances.
- The rare skip is inspectable in source, CI output and release history.
