---
title: "Evidence audit for the agent runtime framework"
description: "Разложить реальные consumer AI layers на engine, configurable policy, adapter и domain code до public API."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related: docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
---

# Evidence audit for the agent runtime framework

## Зачем

Широкое направление подтверждено, но переносить целые AI folders нельзя. Нужна evidence matrix:
какие mechanics повторяются, где различие вызвано provider/API version, а где это domain policy.
Audit определяет первый release slice и baseline удаления по точным symbols/files.

## Результат

- Matrix `capability -> inspected shapes -> invariant -> variation -> owner -> target task` минимум
  по трём structurally different runtimes.
- Отдельно разобраны engine, adapters, domain, transport и shared wire schemas.
- В scope входят provider parts/opaque metadata, attachment resolution, approval/resume evidence,
  managed tool execution, retry semantics, UI delivery events, operator telemetry, durable
  admission/recovery, crash checkpoints и distributed heartbeat/lease boundary.
- Для каждой зоны verdict: framework engine, typed callback/config, adapter, consumer-owned или reject.
- Pilot и validation consumer обезличены в public artifacts.

## План

- [ ] Инвентаризировать messages/history, prompt/context, compaction, models/providers, loop/stream,
  sessions/runs, persistence, delivery, observability и UI protocols.
- [ ] Проверить, не закрывает ли gap существующий Stitchkit/AI SDK API.
- [ ] Зафиксировать точные версии AI SDK и provider adapters у каждого inspected shape.
- [ ] Найти явно портированные и независимо возникшие реализации одного invariant.
- [ ] Измерить current и removable LOC по конкретным symbols/files, не по целым folders.
- [ ] Зафиксировать negative scope и risks скрытого coupling.
- [ ] Уточнить дочерние tasks, release cuts и deletion targets.
- [ ] Оформить обезличенный research document с traceable evidence.

## Acceptance

- [ ] Каждая capability подтверждена минимум двумя independent consumer shapes либо consumer и
  official external contract.
- [ ] Matrix включает отрицательные выводы и ownership reason.
- [ ] LOC различает copied и independently divergent engine code, adapters, domain, transport,
  tests и generated data.
- [ ] Audit завершён как первый gate до фиксации public API.
- [ ] Выводы достаточны для реализации без private chat history.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: evidence completeness, sampling и product ownership.
- [x] Plan validator 2: falsification, speculative abstractions и LOC/deletion honesty.
- [ ] Implementation validator 1: traceability до inspected code/contracts.
- [ ] Implementation validator 2: private-identity audit и missed-zone challenge.
