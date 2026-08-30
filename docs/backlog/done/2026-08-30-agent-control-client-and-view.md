---
title: Agent control protocol and view projection
description: Publish transport-neutral session controls, ownership leases and a pure snapshot-plus-event view reducer.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 04:01 +0000
pipeline: composable-agent-harness
order: 4
depends-on: 2026-08-30-failed-run-continuation-evidence.md, 2026-08-30-bounded-harness-resource-discovery.md, 2026-08-30-agent-approval-continuations.md
---

## Зачем

The structured runner demonstrates controls but does not publish correlated envelopes, shared
ownership rules or a browser-safe state reducer. Each terminal, web or remote host would otherwise
create its own reconnect rules and interpretation of transient events.

## Результат

- Strict versioned Zod envelopes cover correlated requests/responses, runtime deliveries, errors
  and explicit overflow resynchronization. Framing, handshake and authentication stay host-owned.
- One connection may observe several conversations. Exclusive controller and shared observer leases make
  mutation ownership explicit and reject stale or detached commands.
- Canonical snapshots and successful response snapshots are authoritative. Events are progress;
  gaps and reconnects trigger resynchronization rather than optimistic durable state.
- Transient cursors are keyed by conversation, run and runtime epoch; durable snapshot versions are
  keyed by conversation. Gaps/overflow become an explicit resync state.
- A pure multi-conversation reducer joins authoritative snapshots with streaming text/reasoning and
  resync state without importing a renderer or transport. Rich transcript/tool rendering derives
  from the canonical snapshot rather than a second framework view model.

## План

- [x] Define strict correlated protocol envelopes, lease state machines, delivery limits and error taxonomy.
- [x] Add a bounded event hub at harness construction and implement transport-neutral server/client
  composition over `HeadlessAgentHarness`; do not reach into closed runtime configuration.
- [x] Implement the pure view projection over `AgentSnapshot` and `AgentRuntimeEvent`.
- [x] Keep stdio/WebSocket framing, handshake, authentication and process supervision outside the
  primitive. Ordinary connection close only detaches and never shuts down the harness.
- [x] Cover backpressure/overflow, duplicate/first-gap delivery, reconnect-ID ABA, controller
  downgrade, detach races and listener isolation.

## Acceptance

- [x] A host adapter can submit, observe, interrupt, snapshot, detach and reconnect through the
  protocol without direct access to runtime internals.
- [x] A missed transient event produces a resync requirement; a duplicate event is idempotent.
- [x] Exclusive/shared leases prevent two controllers from racing one conversation.
- [x] No new socket engine or durable session catalog is introduced.

## Что сделано

- Published strict control request/response/delivery schemas, exclusive controller leases, bounded
  serialized delivery, out-of-band overflow detach and browser-safe snapshot/event reducer.
- `packages/core/tests/agent-harness-public.test.ts` — `control connections isolate observer/controller
  leases and detach without closing the harness`, `signals control resync on bounded-delivery overflow without blocking a run`.
- `packages/core/tests/agent-runtime-events.test.ts` — `isolates transient cursors per conversation and run`,
  `treats snapshots as authoritative and requests resync for newer durable state`,
  `detects durable and transient duplicates or reconnect gaps`.
