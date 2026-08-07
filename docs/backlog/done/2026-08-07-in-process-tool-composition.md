---
title: In-process tool composition without error or context loss
description: Подготавливать contract-tool registry один раз, передавать call-specific runtime context и получать исходный нормализованный AppError без consumer adapter
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 15:40 +00:00
related: docs/backlog/done/2026-08-07-in-process-tool-invoker.md
---

# In-process tool composition without error or context loss

## Источник

Интеграция `createToolInvoker` в consuming application выявила две связанные
границы композиции. Registry contract tools можно скомпилировать один раз, но
runtime identity сейчас захватывается в config всего invoker-а, а failure
envelope теряет HTTP status исходного `AppError`. Consumer вынужден создавать
invoker на каждую identity и вручную восстанавливать ошибку со случайным status.

Названия и доменная модель consumer-а в публичном репозитории не фиксируются.

## Проблема

- `context`, `hooks` и `lifecycle` принадлежат созданному invoker-у, хотя auth и
  request context принадлежат отдельному вызову.
- `invoke()` корректно возвращает model-safe `ToolResult`, но после нормализации
  в нём нет status исходного `AppError`.
- Публичный `unwrapToolResult()` не решает потерю: из текущего envelope исходный
  status уже невозможно восстановить.
- Локальный adapter дублирует framework error policy и превращает известные
  application errors в произвольный `500`.

## Целевая модель

Один compiled registry отделён от runtime call options. Точное имя API
определяется реализацией, но должны существовать две явные семантики:

```ts
const invoker = createToolInvoker(services, {
  transport: 'AGENT',
  flattenUnionInput: true,
})

const result = await invoker.invoke(name, args, {
  source: 'internal',
  context: { auth, userId },
  lifecycle,
  hooks,
})

const data = await invoker.invokeOrThrow(name, args, {
  source: 'internal',
  context: { auth, userId },
  lifecycle,
  hooks,
})
```

`invoke()` остаётся envelope API для model/tool orchestration.
`invokeOrThrow()` — in-process composition API: success возвращает validated
data, failure бросает тот же нормализованный `AppError`, который создал runner,
включая `code`, `status`, `details`, `message` и `hint`.

## Инварианты

- Registry, operation identities и presentation schemas компилируются один раз.
- Auth/context не кешируются и не разделяются между параллельными calls.
- Оба режима используют один canonical runner; второго execution engine нет.
- Input/output validation, lifecycle и hooks выполняются ровно один раз.
- `afterToolCall` получает тот же terminal result в throwing и envelope режимах.
- Unexpected errors остаются scrubbed `INTERNAL_SERVER_ERROR`; throwing API не
  раскрывает stack/message, которые framework намеренно скрывает.
- Unknown tool остаётся fail-first `NOT_FOUND` с available names.

## План

### 1. Разделить preparation и call runtime

- [x] Отнести transport surface shaping (`transport`, `extend`, flattening) к
      compile config, а `source`, context, lifecycle и hooks — к call options.
- [x] Выбрать один чистый public shape без static/dynamic дублей и неявного
      precedence между двумя context sources.
- [x] Оформить breaking migration, если сигнатура `createToolInvoker` меняется;
      aliases и compatibility wrappers не оставлять.

### 2. Сохранить нормализованную ошибку

- [x] Провести normalized `AppError` через internal runner до terminal outcome,
      не добавляя HTTP-specific поле в model-facing `ToolResult` без нужды.
- [x] Добавить throwing invocation поверх того же terminal outcome.
- [x] Сохранить исходный status application `AppError` и framework statuses для
      validation, lifecycle deny, output mismatch и unknown tool.
- [x] Не делать публичный unwrap helper, который реконструирует уже потерянную
      ошибку приблизительно.

### 3. Покрытие

- [x] Две параллельные identity получают изолированные context и request spans.
- [x] Один prepared invoker безопасно переиспользуется последовательными calls.
- [x] `invoke` и `invokeOrThrow` дают одинаковые validation/lifecycle/hook events.
- [x] Application `AppError` сохраняет code/status/details/message/hint.
- [x] Unexpected throw остаётся sanitized, output failure имеет framework status.
- [x] Docs, API reference, generated llms и changelog описывают обе семантики.
- [x] Полный `bun run verify` зелёный: 887 tests, build, Node smoke и consumer lane.

## Acceptance

- [x] Consumer не пересобирает contract-tool registry на каждую identity.
- [x] Consumer не восстанавливает `AppError` вручную и не придумывает status.
- [x] Envelope и throwing modes не расходятся по lifecycle, audit и validation.
- [x] Framework не вводит второй runner или compatibility shim.

## Вне scope

- Кэш per-server SDK registration для runtime MCP tools. Свежий `McpServer`
  всё равно требуется на каждый stateless request; отдельная оптимизация допустима
  только после benchmark, который покажет существенную стоимость именно native
  schema preparation.

## Что сделано

- [x] **Invoker API:** `packages/core/src/tools/invoker.ts` разделяет immutable
      compile config и `ToolInvocationOptions`; `invokeOrThrow` использует тот же runner.
- [x] **Error semantics:** `packages/core/src/tools/execute.ts` удерживает normalized
      `AppError` вне model-facing envelope и сохраняет application status/details/hint.
- [x] **Public types:** `ToolInvocationOptions` экспортирован через
      `packages/core/src/tools.ts`; static runtime-config overload не оставлен.
- [x] **Tests:** `packages/core/tests/tool-invoker.test.ts` покрывает throwing mode,
      framework statuses, per-call identity isolation и recursive composition.
- [x] **Docs:** обновлены guide, API reference, upgrade migration, changelog и
      generated `packages/core/llms*.txt`.
- [x] **Validation:** `bun run verify` прошёл — 887 tests, build, Node smoke и
      все consumer lanes зелёные.
- [x] **Не делалось:** native MCP registration cache, commit, push, release и
      миграция внешних consumers.
