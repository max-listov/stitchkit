---
title: "Realtime contracts in surface manifests and conformance probes"
description: Добавить schema snapshots, discovery и bounded behavioral probes для realtime events и acknowledgements.
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
related: docs/decisions/0093-transport-projected-and-realtime-conformance.md
---

# Realtime surface manifest и conformance probes

## Зачем

`stitchkit/testing` ограничивает transport union значениями
`HTTP | MCP | AGENT | CLI`. Realtime contracts уже имеют направления, Zod
argument schemas, optional acknowledgements и stable rejection/request errors,
но consumer не может включить их в единый schema snapshot и production-shaped
conformance gate.

Внутренние socket tests доказывают framework implementation, а не соответствие
конкретного application contract его реально смонтированному client/server
transport.

## Результат

- Manifest config принимает explicit named realtime contract registry; snapshot
  содержит name, direction, event и отдельные representable input/output
  digests аргументов и ack.
- Discovery assertion сравнивает объявленные events только с явно переданной
  caller-observed fixture topology: Socket.IO не имеет универсального удалённого
  introspection API.
- Realtime-specific probe driver нормализует success, contract rejection,
  invalid ack, disconnected и timeout outcomes без запуска server/credentials
  самим framework.
- Canonical probe helpers покрывают valid event, valid ack, invalid inbound
  args с caller-supplied `handlerCalls` observation, invalid ack, disconnected before
  request, in-flight disconnect и bounded timeout.
- Caller поставляет explicit fixtures/invalid values; framework не пытается
  генерировать произвольные контрпримеры из Zod schema.

## План

- [x] Разделить declarative schema snapshot и behavioral runtime outcomes;
      handshake/rooms/business delivery не приписывать contract'у.
- [x] Расширить общий manifest v2 schema/digest canonicalization realtime contracts и
      named role/transport projections из соседней задачи.
- [x] Определить realtime observation/rejection schema с direction/phase/reason
      и stable request error codes.
- [x] Добавить driver/adapters поверх bound existing transport и один absolute
      scenario deadline для signalled setup/invoke/teardown. Outer timeout не
      disconnect'ит foreign transport и не обещает отмену отправленного packet.
- [x] Реализовать canonical scenario helpers без automatic invalid-data
      synthesis и без process/server ownership.
- [x] Покрыть schema order determinism, event/ack drift, both directions,
      handler-not-called, invalid ack, disconnect-vs-timeout и hung driver.
- [x] Обновить ADR/reference/testing guide/generated docs/changelog и public
      surface fixtures.

## Acceptance

- [x] Representable realtime topology/input/output schema change создаёт
      deterministic manifest diff; refine semantics вне JSON Schema не
      заявляются как fingerprinted.
- [x] Invalid payload/ack outcome содержит точные direction/phase/reason и не
      вызывает protected handler.
- [x] Immediate disconnect, in-flight disconnect и timeout различимы.
- [x] Один timeout/cancellation budget ограничивает non-cooperative probe.
- [x] Kit не открывает ports, не создаёт credentials и не заявляет delivery
      guarantees, которых нет в realtime contract.
- [x] Public `REALTIME` transport-union expansion отмечен как source-breaking
      для exhaustive consumer records.
- [x] `bun run verify` зелёный.

## Конвейер 2/2

- [x] Plan validator 1/2 — уточнены name, input/output digests и observations.
- [x] Plan validator 2/2 — уточнены deadline и foreign transport ownership.
- [x] Implementation validator 1/2 — PASS: observation schema требует точные
      rejection/disconnect phases и handler-call evidence.
- [x] Implementation validator 2/2 — PASS: real bound transport, per-invocation
      rejection isolation и единый bounded scenario deadline закрыты.

## Что сделано

- [x] Manifest: named realtime contracts snapshot'ят обе directions, args/output
      и ack input/output digests; даже пустой registry сохраняет identity.
- [x] Conformance: `createRealtimeProbeDriver` работает поверх caller-owned
      bound transport, нормализует events/acks/invalid payload/disconnect/timeout
      и не открывает ports или credentials.
- [x] Регрессии:
      `packages/core/tests/surface-conformance-kit.test.ts::snapshots named realtime directions and acknowledgement schemas`;
      `packages/core/tests/surface-conformance-kit.test.ts::normalizes a real bound transport across event, ack, rejection and disconnect scenarios`;
      `packages/core/tests/surface-conformance-kit.test.ts::isolates a late rejection from the next realtime probe invocation`;
      `packages/core/tests/surface-conformance-kit.test.ts::setup, invoke and teardown share one bounded scenario deadline`.
