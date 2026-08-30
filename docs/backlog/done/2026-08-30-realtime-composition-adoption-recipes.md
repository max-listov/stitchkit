---
title: Document and prove minimal realtime composition with existing application and UI primitives
description: Publish packed Socket.IO and HTTP-stream compositions after the synchronization controller is proven.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 15:08 +0000
pipeline: live-state-synchronization
order: 2
depends-on: 2026-08-30-live-snapshot-event-synchronization.md
---

## Зачем

Reusable mechanics only reduce application complexity if the public composition is small and
understandable. Otherwise each application rebuilds wrappers around the wrappers. Existing
lifecycle, HTTP streams and React Query integration already address much of the need.

This inbox task is the post-controller adoption slice. It does not authorize migration of any
consuming repository or a new starter framework.

## Current review disposition

The initial intake mixed pre-design proof with final documentation, which created a lifecycle
cycle: this task could not close before the controller that depended on it. Pre-design test-local
proof now belongs to the synchronization task. This task begins only after that controller and its
internal conformance are accepted, then converts the proven source bindings into packed regression
fixtures and public recipes.

## Результат

Executable examples demonstrate independent adoption:
- A replaceable progress/status view using snapshot synchronization and an absolute-state reducer.
- An ordered records view with bounded queues and explicit gap/resync.
- Existing Socket.IO and typed HTTP-stream composition against the same synchronization
  semantics, without pretending that their transport capabilities or wire formats match.
- Headless subscribe/getSnapshot usage plus optional existing React Query cache projection.

## Existing APIs to reuse

`createCacheBridge` already accepts an emitter's on-to-unsubscribe interface:
`packages/core/src/react/cache-bridge.ts`. Do not create another hook factory.
`createApplication`, managed resources, readiness, admission and bounded shutdown already
provide process-local lifecycle. Typed HTTP SSE/NDJSON parsing already validates frames and
terminal lifetime. Their integration is a recipe until a demonstrated gap justifies an API.

## План

- [x] Choose at least two domain-neutral scenarios with different ordering/recovery requirements.
- [x] Replace proof-local synchronization logic with the accepted public controller; preserve the
      negative unsafe-boundary fixture in the controller suite.
- [x] Show resource startup, readiness, active subscription lifetime and shutdown through the
      existing application/server mechanisms, without making the application kernel mandatory.
- [x] Show cache updates only after valid synchronization; distinguish markFresh time-window
      echo suppression from revision/cursor-based duplicate detection.
- [x] Demonstrate a renderer-neutral store and React Query integration without requiring a
      new Zustand adapter, universal store or UI component package.
- [x] Explain how a one-way HTTP stream can reuse receiver synchronization without acquiring
      socket request/ack capabilities.
- [x] Document migration from hand-written connections: remove superseded reconnect loops,
      timers and listeners; keep application schemas, authorization, reducers and storage.
- [x] Keep Vite HMR and development proxying separate, referencing the existing frontend
      integrations guide rather than routing HMR through application event envelopes.
- [x] Update guide/reference, accepted ADR index and generated-doc inputs through the normal
      implementation flow; do not hand-edit generated llms files.

## Acceptance

- [x] Both final examples run from packed public imports and demonstrate recovery/cleanup, not
      only TypeScript compilation or a mocked transport.
- [x] A non-React consumer can adopt core mechanics; a one-way HTTP-stream consumer does not
      acquire socket request/ack semantics.
- [x] Application startup/shutdown uses already-shipped APIs without a competing supervisor.
- [x] Examples expose gap/resync and scope isolation instead of hiding them behind refreshes.
- [x] Source/wire migrations and unsupported features are explicit and require no dual source
      of truth, compatibility aliases or mandatory frontend framework.
- [x] No private consumer name, infrastructure detail, domain or path appears in public examples.

## Что сделано

- `packages/core/scripts/consumer-lane/fixtures/minimal/src/streaming-subscription.ts` proves a
  renderer-neutral ordered HTTP stream and an independently managed progress resource through
  start, gap, explicit resync, scope replacement and shutdown using packed root imports.
- `packages/core/scripts/consumer-lane/self-contained-socket-client.mjs` proves a separately
  spawned Socket.IO peer, an event crossing the snapshot acknowledgement boundary, gap detection,
  explicit resync and cleanup with a bounded deadline.
- `packages/core/scripts/consumer-lane/fixtures/full/src/app.ts` projects only synchronized state
  into the existing React Query cache surface; no new renderer or store dependency was added.
- `docs/guide/realtime.md`, `docs/api/reference.md`, ADR 0137 and generated `llms` inputs document
  ownership, migration, unsupported capabilities and the separate Vite HMR path.
