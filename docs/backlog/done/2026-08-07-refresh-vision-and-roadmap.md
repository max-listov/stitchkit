---
title: Refresh VISION and ROADMAP for the 0.37 line
description: Remove stale 0.1-era claims and completed future work from the project overview so it describes the framework that is actually shipped.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
related: docs/VISION.md
completed: 2026-08-07 07:15 +00:00
---

# Refresh VISION and ROADMAP for the 0.37 line

> **Target release:** 0.37.0 documentation pass. This changes no product scope;
> it makes the overview agree with the released framework and backlog.

## Verified drift

- `docs/VISION.md` still gives an exact `~8500` source-line count; the current
  TypeScript source is roughly 12.9k lines, so the supposedly durable principle
  is already stale.
- `ROADMAP.md` labels the present as `0.1.x`, says those releases are additive
  only, and lists OpenAPI generation as future inbox work. The package is
  0.36.1, breaking minors are an established pre-1.0 policy, and OpenAPI shipped.
- Several newer first-class surfaces — Node, CLI, observability, binary responses,
  MCP Apps and consumer-lane verification — are missing from the overview.

## Implementation plan

1. Rewrite VISION's status/capability summary from current public entrypoints and
   principles. Replace the exact line count with a durable statement about a
   small, inspectable core rather than another number that will rot.
2. Rewrite ROADMAP's "Now" around the current pre-1.0 line without pinning a
   short-lived patch version. Mark OpenAPI and the other shipped capabilities as
   present, linking to their guide/ADR/done records.
3. Keep "toward 1.0" focused on API stability proven across consumers,
   documentation quality and examples. Do not invent new product surface merely
   to fill the roadmap.
4. Preserve the explicit non-goals: no fullstack framework, no competing socket
   or hook engine, Bun first-class with Node support rather than more runtimes.
5. Audit every overview link against the current repository and remove links to
   moved/nonexistent inbox files. Update document frontmatter dates.
6. Mention the refresh in the 0.37.0 changelog only if release notes carry a docs
   section; no ADR is needed because no architectural decision changes.

## Acceptance

- [x] VISION describes the current product without a volatile source-line count
- [x] ROADMAP no longer calls 0.1.x current or OpenAPI future work
- [x] Current entrypoints and major shipped surfaces are represented accurately
- [x] The 1.0 direction remains API stability through real consumer usage
- [x] Every local link resolves to a current file
- [x] No new feature promise, deadline or domain-specific scope is introduced

## Что сделано

- [x] **VISION:** `docs/VISION.md` now describes the current multi-transport
      framework, its verification model and evidence-driven path to 1.0 without
      a volatile line count.
- [x] **ROADMAP:** `ROADMAP.md` replaces the 0.1-era snapshot with the shipped
      Bun/Node, OpenAPI, MCP/native/MCP Apps, CLI, observability, binary and
      packed-consumer capabilities.
- [x] **Direction/non-goals:** 1.0 remains API stability proven across real
      consumers; fullstack ownership, competing realtime/data engines and more
      runtimes remain explicitly out of scope.
- [x] **Links:** every local link in both overview documents was resolved
      against the current repository; the removed OpenAPI inbox link now points
      to the shipped guide and consumer verification points to its done record.
- [x] **Release notes:** `CHANGELOG.md` carries the overview refresh under a
      documentation section. No ADR was added because product scope did not
      change.
