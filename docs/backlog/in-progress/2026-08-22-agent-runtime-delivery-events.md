---
title: "Agent runtime application events and delivery projection"
description: "Отделить stable product-facing events/snapshots от AI SDK stream и operator observability."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-loop-and-stream-runtime.md
  - docs/backlog/in-progress/2026-08-22-agent-session-coordination.md
---

# Agent runtime application events and delivery projection

## Зачем

UI/Telegram/WebSocket delivery нужны stable progress/result semantics, но это не AI SDK union и не
operator telemetry. Без отдельной границы loop обрастёт transport callbacks, а reconnect/replay
окажется ошибочно собственностью session coordinator.

## Результат

- Zod-first `AgentRuntimeEvent` различает transient speculative delta, durable checkpoint event и
  terminal/canonical event.
- Transient event получает `(runId, runtimeEpoch, sequence)` после current-run fence, может потеряться
  и не является canonical result. Durable events получают stable ID and `snapshotVersion` только
  после соответствующего CAS.
- `loadSnapshot` — durable reconnect source of truth; transient replay buffer optional and bounded.
- Checkpoint delivery начинается после checkpoint CAS, terminal/result delivery — после terminal CAS;
  без transactional outbox exactly-once не обещается.
- Projection исключает provider-private metadata/internal causes и допускает typed domain extensions.
- Recipes показывают Socket.IO/HTTP/Telegram adapters; transports остаются consumer-owned.

## План

- [ ] Определить application event vocabulary после protocol/loop state tables.
- [ ] Задать sequence, snapshot version, gap and dedup semantics.
- [ ] Разделить durable snapshot, transient deltas and terminal publication.
- [ ] Определить runtime epoch/sequence reset and snapshot-version semantics across restart.
- [ ] Спроектировать typed domain projection/redaction hooks.
- [ ] Добавить transport-neutral publisher lifecycle/backpressure contract.
- [ ] Проверить reconnect after gap, duplicate delivery and late superseded event.

## Acceptance

- [ ] Consumer delivery adapter не читает raw SDK events.
- [ ] Gap восстанавливается durable snapshot-ом, не обещанием infinite process replay.
- [ ] Потерянный transient delta не считается потерей canonical state.
- [ ] Superseded run не публикует new canonical event after fence.
- [ ] UI event и operator telemetry используют разные schemas/lifecycles.
- [ ] Internal provider causes/metadata не уходят наружу by default.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: product event ergonomics, reconnect and domain projection.
- [x] Plan validator 2: ordering, gaps, dedup, privacy and canonical publication.
- [ ] Implementation validator 1: schemas/adapters/docs and transport neutrality.
- [ ] Implementation validator 2: reconnect/duplicate/late-event probes.
