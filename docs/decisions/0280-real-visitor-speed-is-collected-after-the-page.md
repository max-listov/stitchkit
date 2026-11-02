---
title: "ADR 0280: Real-visitor speed is collected after the page"
description: stitchkit/tracking/performance loads web-vitals as an idle chunk, a missing metric is null, and the browser client carries no zod.
type: decision
status: accepted
created: 2026-11-03
updated: 2026-11-03
---

# ADR 0280 — Real-visitor speed is collected after the page

Amends [ADR 0166](0166-tracking-mechanics-in-core-storage-and-domain-outside.md). Serves **I4**, **I9**, **I13**.

## Context

Two consuming projects wrote the same collection of Web Vitals, and a third was about to. A consuming project
also measured the tracking client at 30 393 bytes gzip with `zod` and 6 331 without it, on a storefront with a
150 KB budget for its first load: a fifth of the budget went to schemas that read one stored value.

## Decision

`stitchkit/tracking/performance` owns the mechanics: when to measure, how a sample leaves, what a missing value
means, and when a percentile can be trusted. `web-vitals` stays an optional peer, the measure of record that
browsers change under it, and is imported dynamically after `load` when the page is idle, so it arrives as its
own chunk and the measurement does not slow what it measures.

A metric that did not arrive is `null`. A p95 is withheld below 100 samples. Lab agents send nothing. Both samples
of a load carry one `id`, because the final one can be lost with the page and the early one must still count.

The browser client imports no `zod`. Stored attribution is read by a guard, and the schemas and the contract factory
move to `stitchkit/tracking/contract`. A published entry holds whatever the bundler glued into it, and `sideEffects:
false` drops modules, not the top-level `z.object()` calls inside one, so a client sharing an entry with schemas
reaches `zod` however little of it is used. A test holds the sources under 8 KB gzip, and the build refuses a
published file of `stitchkit/tracking` or `stitchkit/tracking/performance` that reaches `zod`.

The collector stays alone in `stitchkit/tracking/performance`, because its dynamic import needs the peer at build
time. The sample's schema and the report's threshold live with the contract, where a server takes them without
installing `web-vitals`.

The redactor lives in `stitchkit/tracking` because both halves need it. Masking keeps the key: a report that a
`token` parameter arrived is itself useful, and its value never is.

## Alternatives

- Writing the five metrics on `PerformanceObserver`: rejected. INP and the CLS session window change with
  browsers, and a wrong number that looks right is worse than a dependency that an application opts into.
- Reports in Stitchkit: rejected, as ADR 0166 decided. Tables and vocabulary differ per application.
- Keeping the schemas in `stitchkit/tracking` and relying on tree-shaking: rejected. Measured on the published
  files, the client stayed at 30 KB gzip while the sources measured 6 KB.

## Consequences

Importing a schema from `stitchkit/tracking` becomes a one-line change to `stitchkit/tracking/contract`. A page that
closes before idle loses its sample; that costs less than the weight it saves everyone else. A client-side navigation
stays under the route the page opened on, and a local Lighthouse run with `webdriver` off cannot be told from a visitor. Proven in
`packages/core/tests/tracking-performance.test.ts` and `tracking-client-size.test.ts`.
