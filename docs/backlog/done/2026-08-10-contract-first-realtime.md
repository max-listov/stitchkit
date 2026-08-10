---
title: Zod-first realtime contracts over Socket.IO
description: Define realtime event payloads once and derive typed, runtime-validated Socket.IO server and client boundaries without replacing Socket.IO.
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 13:39 +07:00
---

## Зачем

HTTP and tool transports derive types and runtime validation from the same Zod
contracts, while realtime currently starts from TypeScript callback interfaces.
Consumers must add validation manually and can let server/client event shapes drift.
Durable subscriptions and the cache bridge already solve reconnect and cache plumbing;
the missing layer is a shared runtime contract, not a new WebSocket engine.

## Результат

A shared `defineRealtimeContract` describes client-to-server and server-to-client
wire events with Zod. Stitchkit derives typed server/client operations and validates
untrusted inbound payloads while continuing to use Socket.IO for transport,
handshake, rooms, delivery and reconnection.

## План

- [x] Specify event descriptors that represent Socket.IO argument tuples and acknowledgements without weakening them to `unknown` or forcing every event into an artificial object envelope.
- [x] Derive event-map types from the Zod contract; do not require parallel handwritten interfaces.
- [x] Add contract-aware server and browser adapters over the existing Socket.IO handles.
- [x] Validate client-to-server payloads before application handlers and server-to-client payloads at the framework-owned emission boundary.
- [x] Define fail-closed behavior and a typed error/observability hook for rejected realtime events; never silently drop malformed input.
- [x] Preserve durable subscriptions, retained events, reconnect auth and cache-bridge compatibility.
- [x] Keep handshake authentication, room membership, authorization and targeted-delivery policy application-owned and document the boundary explicitly.
- [x] Cover single payloads, variadic tuples, no-payload events, acknowledgements, binary payloads, invalid input and reconnect behavior on Bun and Node lanes.
- [x] Add the public API to the realtime guide, API reference, generated LLM docs and changelog.

## Acceptance

- [x] One Zod realtime contract is the sole source for server and client event types.
- [x] Malformed inbound event arguments never reach the application handler.
- [x] Framework-owned outbound emission cannot publish data that violates its event contract.
- [x] Socket.IO remains the transport; no competing websocket, room or reconnect engine is introduced.
- [x] Existing cache bridge and retained-topic behavior work with inferred contract event types.
- [x] Bun and Node integration tests cover real Socket.IO connections and acknowledgements.
- [x] No legacy parallel API, schema-free alias or consumer-specific event is added.

## Что сделано

- [x] Shared API: добавлены Zod-first descriptors и вывод типов в `packages/core/src/realtime/contract.ts`.
- [x] Browser/server: добавлены `createRealtimeClient` и `bindRealtimeServer` поверх Socket.IO в `packages/core/src/realtime/socket.ts` и `packages/core/src/server/realtime.ts`.
- [x] Validation: inbound/outbound payloads и acknowledgements валидируются fail-closed с типизированным rejection hook.
- [x] Tests: реальные Socket.IO соединения, ack, invalid payload, rooms и retained flow покрыты в `packages/core/tests/socket-io.test.ts` и Node smoke.
- [x] Docs: public API описан в `docs/guide/realtime.md`, `docs/api/reference.md` и `CHANGELOG.md`.
