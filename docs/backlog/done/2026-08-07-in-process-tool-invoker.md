---
title: In-process contract tool invoker
description: Публично выполнять contract tool по имени через общий runner без монтажа AI SDK ToolSet как внутреннего диспетчера
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 14:08 +00:00
related: docs/backlog/inbox/2026-08-07-native-agent-runtime-tools.md
---

# In-process contract tool invoker

## Источник

Кросс-аудит реального consumer-а: universal mutation tool диспетчеризует вызов в
конкретный contract tool, но для этого каждый раз строит полный `mountAgent`,
находит AI SDK tool и вручную вызывает его `execute`. Это корректно по semantics,
но использует transport adapter как внутренний application API.

## Проблема

Stitchkit уже имеет `collectTools`, `createToolRunner` и `executeToolMethod`, но
не предоставляет безопасный public in-process dispatcher. Consumer вынужден:

- повторно монтировать всю поверхность на каждый nested call;
- зависеть от AI SDK execute options там, где AI SDK не участвует;
- самостоятельно распознавать success/error presentation object;
- рисковать расхождением context/lifecycle/hooks с обычным tool call.

## Целевая модель

```ts
const invoker = createToolInvoker(services, {
  context,
  lifecycle,
  hooks,
  flattenUnionInput: true,
})

const result = await invoker.invoke('entity_update', args)
```

Конкретные имена API уточняются по существующей архитектуре; пример фиксирует
семантику, а не обязательный spelling.

## Уточнённая граница реализации

- API: `createToolInvoker(services, config) → { names, invoke(name, args) }`.
- `config.transport` обязателен и выбирает существующую exposure policy
  (`MCP | AGENT | CLI`); скрытого internal-режима, обходящего `expose`, нет.
- `config.source` по умолчанию `internal`, отдельно от выбранной policy, чтобы
  audit честно называл фактический in-process вызов.
- `invoke` возвращает канонический `ToolResult`; lookup failure бросает
  `AppError(NOT_FOUND)` до runner, поскольку operation identity для hooks нет.
- Lookup и extension carrier компилируются один раз при создании invoker;
  каждый вызов идёт через существующий `createToolRunner`/`executeToolMethod`.

## План

- [x] Выделить public invoker поверх существующего mount/execute runner без
      копирования validation/error code.
- [x] Компилировать immutable name→operation lookup один раз на invoker.
- [x] Создавать fresh per-call context внутри `invoke`, включая nested и parallel calls.
- [x] Поддержать те же `extend`, flattened-union presentation, lifecycle,
      hooks, output validation и output-strip reporting, что MCP/Agent.
- [x] Возвращать typed discriminated result либо бросать каноническую ошибку;
      не протаскивать AI SDK presentation envelope во внутренний API.
- [x] Явно определить duplicate/unknown tool behavior и tool-name ratchet.
- [x] Не разрешать обход `expose`: invoker получает явный transport/surface
      policy либо отдельный осознанный internal mode.
- [x] Проверить recursive invocation и защититься только от доказанной
      context-sharing проблемы, без глобального mutable state.
- [x] Экспортировать API из `stitchkit/tools`, обновить reference/guide/llms/changelog.

## Tests

- [x] Success и typed input/output.
- [x] Unknown/duplicate names.
- [x] Input failure, lifecycle deny, handler throw и output validation failure.
- [x] Hooks получают один terminal event с правильной identity и duration.
- [x] Parallel/nested calls изолируют contexts.
- [x] Поведение совпадает с тем же operation через `mountAgent` и `mountMcp`.
- [x] Lookup не пересобирается на каждый invoke.
- [x] Полный `bun run verify` зелёный — 880 тестов + build/smoke/consumer lane.

## Acceptance

- [x] Внутренний dispatcher не монтирует AI SDK ToolSet.
- [x] Invoker использует единственный framework runner.
- [x] Нельзя случайно обойти lifecycle, hooks или output validation.
- [x] API не вводит HTTP/domain model и не создаёт compatibility wrapper.

## Что сделано

- [x] **Tools:** `packages/core/src/tools/invoker.ts` добавляет immutable
      `createToolInvoker` с обязательной exposure policy и canonical `ToolResult`.
- [x] **Runner:** invocation делегируется `collectTools` + `createToolRunner`;
      validation/lifecycle/hooks/isolation/output strip не дублируются.
- [x] **Safety:** unknown name бросает `AppError(NOT_FOUND)`, duplicate/invalid
      names падают при compilation, скрытого bypass-all режима нет.
- [x] **Tests:** `packages/core/tests/tool-invoker.test.ts` покрывает failures,
      extend, hooks, output strip, parallel/recursive isolation и MCP/Agent parity.
- [x] **Public surface:** exports добавлены в `packages/core/src/tools.ts`;
      guide/reference/changelog/generated llms и ADR 0054 обновлены.
- [x] **Что НЕ делалось:** AI SDK/MCP presentation envelopes и domain/HTTP model
      во внутренний API не переносились.
