---
title: "Bind realtime contracts to an existing client transport"
description: Позволить добавить typed validation и acknowledgements поверх уже созданного Socket.IO client без второго соединения.
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
related: docs/decisions/0092-existing-realtime-transport-binding.md
---

# Bind realtime contract к существующему transport

## Зачем

`createRealtimeClient` всегда создаёт и lifecycle-own'ит новый
`createSocketIOClient`. Приложение с уже существующим Socket.IO transport не
может постепенно добавить contract validation и typed acknowledgements: ему
приходится либо переносить всё соединение целиком, либо открывать второй socket.

Contract adapter должен владеть validation/request semantics, но не обязан
владеть созданием transport. Одновременно публичный low-level
`SocketIOClient.emitWithAck` был добавлен в `0.55.0` как required structural
member без отдельного breaking migration note; это надо сделать правдивым.

## Результат

- Новый `bindRealtimeClient(contract, transport, options?)` строит тот же
  validated `on`/`emit`/`request` surface поверх уже созданного Stitchkit
  Socket.IO transport и не открывает соединение.
- Минимальная `RealtimeClientTransport` capability (`connected`, unsubscribe-
  returning `on`, boolean `emit`, `emitWithAck`, `onConnectionChange`) выделена
  в узкий публичный structural type;
  validated binding не требует URL/auth/reconnect config и не присваивает себе
  lifecycle ownership.
- `createRealtimeClient` использует binding как единственный implementation
  path, добавляя только owned construction/connect/disconnect.
- Subscriptions, rejection hook, ack validation, disconnect и timeout semantics
  не расходятся между created и bound clients.
- Changelog/upgrading честно описывают structural impact low-level ack
  capability для mocks/adapters без compatibility alias.

## План

- [x] Выписать минимальные capabilities существующего transport и отделить их
      от owned connect/disconnect lifecycle.
- [x] Определить Zod/TypeScript-derived `BoundRealtimeClient` без
      `connect`/`disconnect` и transport type
      без Socket.IO peer в eager browser graph.
- [x] Реализовать `bindRealtimeClient`, переиспользовав canonical validated
      socket и request-error pipeline.
- [x] Перевести `createRealtimeClient` на binding без второго поведения.
- [x] Покрыть existing transport, durable subscriptions, ack success/invalid,
      disconnected-before-request, in-flight disconnect, timeout и отсутствие
      connect side effect.
- [x] Обновить public exports, API/guide/generated docs, public-surface fixture,
      browser-clean assertions и truthful `0.55.0` migration note.

## Acceptance

- [x] Binding существующего transport не создаёт и не подключает второй socket.
- [x] Created и bound clients проходят одну матрицу validation/request ошибок.
- [x] Lifecycle ownership виден из типа: bound client не обещает закрыть чужой
      transport.
- [x] Root/browser import не получает eager `socket.io-client` dependency.
- [x] Structural mocks получают точный migration example для ack capability.
- [x] Bind-time diagnostics отвергают transport без обязательной capability;
      timeout ограничивает Promise, но не заявляет отмену уже отправленного
      чужим transport ack packet.
- [x] `bun run verify` зелёный.

## Конвейер 2/2

- [x] Plan validator 1/2 — PASS: seam совпадает с текущим validated adapter.
- [x] Plan validator 2/2 — PASS: ownership/deadline границы достижимы.
- [x] Implementation validator 1/2 — PASS: API ownership, receiver binding и
      created/bound semantics совпадают.
- [x] Implementation validator 2/2 — PASS: lifecycle остаётся у caller-owned
      transport, validation/request pipeline общий.

## Что сделано

- [x] Core: `bindRealtimeClient` и узкий `RealtimeClientTransport` добавляют
      contract validation/ack requests поверх существующего transport без
      connect/disconnect ownership; `createRealtimeClient` делегирует тому же
      binding path.
- [x] Public surface: browser exports, API reference, realtime guide, generated
      docs и structural migration для `emitWithAck` синхронизированы.
- [x] Регрессии:
      `packages/core/tests/socket-io.test.ts::binds validation to an existing transport without owning its lifecycle`;
      `packages/core/tests/socket-io.test.ts::preserves the existing transport receiver for connection subscriptions`;
      `packages/core/tests/socket-io.test.ts::rejects an incomplete existing transport at bind time`.
