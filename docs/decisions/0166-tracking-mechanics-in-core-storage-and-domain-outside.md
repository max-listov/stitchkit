---
title: Tracking mechanics live in core; storage and domain stay outside
description: Two consuming applications carried the same visitor-tracking mechanics and fixed the same defects one at a time. The mechanics and the pure decisions move into stitchkit; the tables, the transaction, the event vocabulary and the reports do not.
type: decision
status: active
created: 2026-09-06
updated: 2026-09-06
---

# 0166 — Tracking mechanics live in core; storage and domain stay outside

## Decision

`stitchkit/tracking` (browser) owns the mechanics of visitor tracking: a
tab-shared outbox with reserved sequence numbers and a short flush lease,
delivery with one bounded retry, the page-leave beacon with a string body and
a queued copy, additive visible time, scroll milestones, declarative clicks,
UTM first/current touch, and the client that composes them behind a host
interface. `stitchkit/tracking/server` owns the decisions: batch dispositions,
the visit-lease algorithm over a store the application implements, active
intervals, the bot filter, process-local presence.

Neither owns a table, a transaction, an event type, a referrer list, a
React component or a report. Both are **evolving**.

## The evidence

On 2026-09-06 two consuming applications held the same browser code nearly
verbatim — `delivery.ts` differed by 18 lines, `outbox.ts` by exactly the
fixes one of them had made — and the same server algorithm written twice. The
second application had found and fixed four defects in the shared mechanics:

- a ten-second flush lease that a dying document never released, so the next
  document's first flush waited the whole ten seconds;
- an event that got its sequence number when it was written, so the page-leave
  event awaited IndexedDB inside `pagehide` and the document died first;
- a page-leave beacon with a JSON `Blob`, which reports success and dies on the
  preflight it cannot have (ADR 0165);
- a component-level guard against double mounting that a remount cannot see.

The first application still carried three of the four. That is the cost of a
copy: a fix lands where it was found and nowhere else, and nothing tells the
other copy. A third application had a third implementation of the same class
with a different identity model (a bearer token, not a cookie); it shares the
beacon defect and little else, and this decision does not pretend otherwise —
it adopts the beacon and the scroll milestones, and keeps its own queue.

## Why the boundary is here and not where the request put it

The request proposed the server half with the advisory lock, the
conflict-aware insert and "the shape of the tables as a schema contract, as
`stitchkit/files` does". `files` does no such thing: it exports a path/ref
boundary. `packages/core/src` contains no Postgres, no Prisma and no advisory
lock; the only entries that own a database are `agent-runtime/sqlite/{bun,node}`,
and those are optional adapters behind `AgentRuntimeStore` — the application
implements the interface, the runtime owns the algorithm. That is the pattern
here too: `TrackingVisitStore` is six methods the application writes over its
own tables inside its own transaction; `issueVisitLease` is the algorithm that
calls them in the right order under the lineage lock. `dispositionTrackingBatch`
takes the visits and stored hashes the application read and returns what to
write, including which anonymous visits the caller may adopt — so adoption
stays in the application's transaction, where its `SESSION_MERGE` event and its
first-touch capture already live.

VISION says applications own their database adapter. Owning a `Visit` table
from inside the framework would make this the first entrypoint to dictate a
consumer's schema, and there is no version of that which survives the second
consumer's `schoolId` column.

## ADR 0002, answered

The core is generic and carries no domain model. Two things in this module
look like domain and are not; two things that would be domain are parameters.

Not domain: the event **envelope** (`eventId`, `visitId`, `browserStreamId`,
`browserSequence`, `type`, `page`, `metadata`, `clientTimestamp`) and the
**dispositions** (`accepted`, `duplicate`, `identity-invalid`, `excluded-bot`).
Both applications had them word for word before this module existed; they
describe the mechanics — idempotency, lineage, ordering — not a product.

Parameters: the **event types** (a `z.enum` the application passes, with an
optional `eventExtras` object for fields it carries beside the envelope), and
the **referrer map** (`t.me` → `telegram` / `social` is a marketing decision;
the framework ships no list, and an unmatched external referrer is a
`referral`). The `data-track*` attribute names are configurable for the same
reason. The names of the events the client itself emits (`PAGE_VIEW`,
`PAGE_LEAVE`, …) are a required `builtin` map, typed against the application's
metadata map, so the client speaks the application's vocabulary rather than
imposing one; `CONVENTIONAL_TRACKING_EVENT_TYPES` is the set both consumers
happen to use, offered, not assumed.

## The host interface

Everything the client takes from a browser — page context, visibility, scroll
depth, `pagehide` and friends, intervals, clocks, storage — is one
`TrackingHost` object, and `browserTrackingHost()` is the tab. This is what
makes the client a plain object a test can drive without a DOM, and it is what
lets the mutation tests in this repository put each of the four defects back
and watch the named test redden. It is also the seam a non-tab host (a WebView
that never fires `pagehide`) would use.

## What stays outside, and why

- **GeoIP.** A MaxMind reader with hot reload is a new runtime dependency and a
  file-watching lifecycle; all three consumers copy it too, and it deserves its
  own decision rather than a ride on this one.
- **React.** The provider is forty lines of glue that own the router and the
  session's readiness — both the application's. It is shown in the guide.
- **Reports, labels, the analytics page, Socket.IO push.** The reason the two
  applications' tracking *looks* different.
- **The consumers' migrations.** Both are several breaking minors behind; the
  migration begins with the upgrade and is each consumer's task.

## Consequence

- Entrypoints `stitchkit/tracking` (browser + server) and
  `stitchkit/tracking/server` (server), both evolving, registered in the one
  entrypoint list.
- `fake-indexeddb` as a devDependency, so the IndexedDB adapter consumers run
  is the one the suite exercises — a memory-only test would leave the real
  adapter unexecuted.
- `createTrackingContract` sets `safelistedBody: true` on `track`, so a
  consumer inherits ADR 0165's requirement of an explicit `cors.origin`.

## Related

- ADR 0165 — the safelisted body the beacon depends on.
- ADR 0002 — no domain model in the core.
- ADR 0161 — why the schema factory has two overloads instead of a conditional spread.
