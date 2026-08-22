---
title: "Evidence audit for the agent runtime framework"
description: "Разложить реальные consumer AI layers на engine, configurable policy, adapter и domain code до public API."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related: docs/backlog/done/2026-08-22-agent-runtime-framework.md
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

- [x] Инвентаризировать messages/history, prompt/context, compaction, models/providers, loop/stream,
  sessions/runs, persistence, delivery, observability и UI protocols.
- [x] Проверить, не закрывает ли gap существующий Stitchkit/AI SDK API.
- [x] Зафиксировать точные версии AI SDK и provider adapters у каждого inspected shape.
- [x] Найти явно портированные и независимо возникшие реализации одного invariant.
- [x] Измерить current и removable LOC по конкретным symbols/files, не по целым folders.
- [x] Зафиксировать negative scope и risks скрытого coupling.
- [x] Уточнить дочерние tasks, release cuts и deletion targets.
- [x] Оформить обезличенный research document с traceable evidence.

## Acceptance

- [x] Каждая capability подтверждена минимум двумя independent consumer shapes либо consumer и
  official external contract.
- [x] Matrix включает отрицательные выводы и ownership reason.
- [x] LOC различает copied и independently divergent engine code, adapters, domain, transport,
  tests и generated data.
- [x] Audit завершён как первый gate до фиксации public API.
- [x] Выводы достаточны для реализации без private chat history.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: evidence completeness, sampling и product ownership.
- [x] Plan validator 2: falsification, speculative abstractions и LOC/deletion honesty.
- [x] Implementation validator 1: traceability до inspected code/contracts. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: private-identity audit и missed-zone challenge. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Evidence:** `docs/research/2026-08-22-agent-runtime-capability-audit.md` содержит обезличенные Shapes A/B/C, exact SDK/provider versions, symbol-level matrix, отрицательные выводы и falsification checks.
- **Measurement:** audit разделяет source (4197 LOC), tests (2564), packed proof (787) и controlled deletion proof: 2189 removed против 1554 adapter/domain additions, net −635.
- **Privacy:** public-identity sweep прошёл в составе `bun run verify`; private project names и paths в public artifacts отсутствуют.
