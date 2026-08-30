---
title: Agent conversation control and local attachment
description: Make durable conversations discoverable and let a local client attach to and submit through the same running harness session.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
pipeline: agent-tui-productization
order: 3
depends-on: —
completed: 2026-08-30
---

# Agent conversation control and local attachment

## Зачем

The harness can snapshot a known conversation and has a transport-neutral control server, but a
host cannot list durable conversations and a separate local process has no standard way to find a
running terminal session, submit to its active conversation or observe the resulting run.

## Результат

- A separate optional storage capability provides bounded cursor-based conversation and message
  pages without adding required members to every custom runtime store.
- Control supports conversation listing plus direct submit, interrupt, approval and snapshot flows.
- A Bun local transport publishes a random session id and mode-0600 descriptor, uses a private
  Unix socket, validates every frame and cleans stale descriptors safely.
- A CLI client can list sessions, inspect one and submit text to the same durable conversation the
  terminal is displaying.

## План

- [x] Define conversation summary, cursor, list and paged-history contracts and implement the
  official SQLite composition for Bun and Node.
- [x] Extend the harness/control protocol without weakening exclusive controller leases.
- [x] Implement framed local control transport with request ids, bounds, timeout and cleanup.
- [x] Make queued successor submission explicit and observable instead of blocking the UI.
- [x] Add recovery, stale-process and concurrent-client tests.

## Acceptance

- [x] Listing is bounded, stable and isolated across stores and conversations.
- [x] Custom `AgentRuntimeStore` implementations remain source-compatible without the optional
  catalog/reader capability.
- [x] Programmatic submit returns an admitted run id and the displayed conversation observes it.
- [x] Unauthorized, malformed, oversized and stale local requests fail closed.
- [x] Restart/recovery preserves durable conversation identity but never reuses a stale live session.

## Что сделано

SQLite exposes optional bounded conversation/history readers without widening custom stores. The
TUI publishes an authenticated mode-0600 Unix-socket session, validates bounded request frames and
routes status, submit and interrupt through its one live controller. Liveness is authenticated,
not inferred from PID reuse, and stale descriptors are removed without following foreign paths.

## Регрессия

- `packages/core/tests/agent-runtime-sqlite.test.ts` — `pages conversation summaries and active
  history through an optional reader`.
- `packages/tui/tests/session.test.ts` — `routes authenticated external submissions through the
  live host`.
- `packages/tui/tests/session.test.ts` — `does not publish a stale descriptor merely because its
  pid was reused`.
