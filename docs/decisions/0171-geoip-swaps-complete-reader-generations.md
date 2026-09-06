---
title: GeoIP swaps complete reader generations
description: City and optional ASN databases open as one revisioned generation; failed reloads preserve the last known good reader.
type: decision
status: accepted
created: 2026-09-06
updated: 2026-09-06
---

# 0171 — GeoIP swaps complete reader generations

## Decision

`stitchkit/geo` is a server-only managed resource with three observable states:
`uninitialized`, `unavailable` and `ready`. It accepts a peer-neutral loader;
the optional MaxMind adapter opens City and optional ASN files as one verified
revision, then swaps the complete generation atomically. A failed refresh is
reported while the last known good generation continues serving lookups.

Retired readers close only after their in-flight lookups finish. Private or
invalid IP addresses resolve to `null` before reaching the database.

## Why

Closing a reader while a lookup is using it creates intermittent failures.
Replacing City and ASN independently creates attributions assembled from two
different database revisions. Treating initial absence and refresh failure as
the same state either lies about readiness or throws away valid data.

## Consequences

- `maxmind` is an optional peer loaded lazily by `createMaxMindGeoIpLoader`.
- Applications provide database paths and decide how unavailable/reload errors
  affect their own readiness.
- The framework returns generic attribution fields and owns no download,
  licensing, analytics or storage policy.
