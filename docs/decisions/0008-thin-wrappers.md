---
title: "ADR 0008 — Thin wrappers over the stack you already use"
type: decision
status: accepted
created: 2026-05-20
updated: 2026-05-20
---

# ADR 0008 — Thin wrappers over the stack you already use

- **Status:** Accepted
- **Date:** 2026-05-20

## Context

stitchkit began by trying to own everything. It shipped its own WebSocket
transport (ADR 0009) and its own React data layer — `createReactClient`, a hook
factory built on TanStack Query.

An audit of every project consuming stitchkit told a different story. They all
run on **Socket.IO**. They all use **`react-query-kit`** for the hook layer.
The home-grown stacks were never adopted anywhere — they were dead code, and
each project still hand-wrote the same ~150-line Socket.IO client.

## Decision

stitchkit owns the **contract and the transport**. For everything the consuming
projects already standardise on, it ships a **thin wrapper**, not a competitor.

- **WebSocket is Socket.IO.** `createSocketIOClient` / `createSocketIOServer` —
  typed wrappers with durable subscriptions and a ready-made `/socket.io/*`
  route. The hand-rolled WebSocket stack was deleted (ADR 0009).
- **The React data layer is `react-query-kit`.** `createCursorQuery` is a
  cursor infinite-query helper built on it. The home-grown `createReactClient`
  was deleted.
- **`createCacheBridge`** syncs socket events into the TanStack Query cache. It
  is transport-agnostic — any emitter with `on(event, handler) => unsubscribe`
  qualifies. `markFresh()` plus a short `freshWindow` let a handler skip a
  socket echo of a change the client just made — no double update from the
  mutation and the event together.
- **`createAuthHook` / `createBearerResolver`** — scope-aware auth derived from
  `contract.scope`. This absorbed an earlier `createSessionHook`.
- **`createEventBus<EventMap>()`** — a typed in-process pub/sub, replacing the
  per-project `class EventBus` each project carried.
- **Cursor pagination is the canon.** Every list endpoint returns
  `{ items, nextCursor }`. Cursor beats offset for infinite scroll — it is
  immune to concurrent inserts, where offset drops or duplicates rows. Page
  size is the server's call (the contract's `limit` default), never the
  client's, so the two cannot diverge.

## Consequences

- Less framework code, no competing engines to maintain.
- The wrappers remove roughly 600 lines of duplicated socket-client code across
  the consuming projects.
- Socket.IO, `react-query-kit` and TanStack Query are **optional peer
  dependencies** (ADR 0011) — installed only by apps that use those wrappers.
- This is stitchkit's identity: a contract layer and a transport, plus thin
  wrappers over what the ecosystem already chose — not a framework with its own
  version of everything.
