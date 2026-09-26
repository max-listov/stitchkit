# 0204 — Release cadence is observation, not a gate

**Status:** Accepted
**Date:** 2026-09-26

Amends ADR 0198 and the release consequence in ADR 0203. Invariant I14.

## Decision

Release frequency has no calendar limit. The release planner reports stable-breaking
minor counts over seven and thirty days, but neither count refuses publication.
There is no per-release exception, override flag or alternate publication path.

All remaining compatibility obligations stay in force: a breaking pre-1.0 release
bumps the minor, names the affected entrypoints, cites an ADR for a stable break,
provides a dated changelog and migration with the affected audience, and passes
the full release gates and exact-SHA push CI before publication.

This replaces ADR 0198's one-minor-per-seven-days restriction and the corresponding
refusal. Its stability qualification, entrypoint classification and metadata
requirements remain. ADR 0203's stdin behavior and migration remain; its final
reference to the calendar budget no longer governs publication.

## Reason and verification

A calendar limit blocks a tested fix independently of its correctness or migration
quality. Compatibility is controlled by versioning, explicit migration and evidence.
The release gate tests accept multiple stable-breaking minors in the same week
while still refusing unnamed entrypoints, missing stable ADRs and undated releases.
