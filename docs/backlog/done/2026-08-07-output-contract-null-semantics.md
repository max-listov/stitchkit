---
title: Output contract semantics — nullable JSON и bodyless responses
description: Определять success response по наличию output-контракта, корректно сериализовать null и громко отвергать несовместимый handler result
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 17:33 +00:00
related:
  - docs/decisions/0027-transport-neutral-contract-execution.md
  - docs/decisions/0052-typed-json-response-metadata.md
---

# Output contract semantics — nullable JSON и bodyless responses

## Источник и подтверждённый дефект

Задача пришла из интеграции consuming project и проверена против текущего
Stitchkit `0.40.0`.

В `packages/core/src/server/create.ts` output validation сначала корректно
принимает `null`, если схема nullable, после чего default status вычисляется по
runtime value:

```ts
method.responseMeta?.status ??
  (result === undefined || result === null ? 204 : 200)
```

Следующая проверка отвергает получившееся сочетание `output + 204`. Framework
тем самым принимает результат по контракту, сам превращает его в bodyless
response и сам же отвечает `500`.

OpenAPI уже использует правильную модель: endpoint с `outputSchema` публикует
`200`, без output — `204`. Runtime, typed client и ADR 0052 должны следовать той
же contract-owned семантике.

## Решение

Для обычного contract transport наличие output-схемы определяет форму успешного
ответа; runtime value не выбирает response kind.

- Endpoint с `output` по умолчанию отвечает `200`, валидирует результат и
  JSON-сериализует его. Валидный `null` становится телом `null`.
- `undefined` при объявленном `output` — contract violation даже для широкой
  или optional/undefined-accepting схемы: JSON response не может представить
  `undefined`.
- Endpoint без `output` по умолчанию отвечает `204` и не имеет response body.
  `undefined` и `null` остаются допустимыми empty returns; непустой результат —
  contract violation, а не неописанный JSON body.
- Явный body-capable `responseMeta.status` переопределяет только status, но не
  response kind. `204`/`205` вместе с `output` остаются definition-time ошибкой
  и дополнительно защищаются на runtime `MethodDef` boundary.
- Raw-response endpoints и низкоуровневый `respondJson()` сохраняют собственную
  value-owned семантику: эта задача меняет только contract execution.

## План

### 1. Единый output invariant

- [x] Вынести или локально сформулировать одну проверяемую семантику результата:
      `outputSchema` требует JSON value (включая валидный `null`, исключая
      `undefined`); отсутствие schema допускает только empty return.
- [x] Не выводить наличие тела из truthiness/value результата и не добавлять
      fallback, который молча меняет contract kind.
- [x] Сохранить output-strip diagnostics и классификацию неверного handler
      output как `INTERNAL_SERVER_ERROR`, не client validation error.

### 2. HTTP contract runner

- [x] В `packages/core/src/server/create.ts` вычислять default status как
      `method.outputSchema ? 200 : 204`, учитывая явный
      `method.responseMeta?.status`.
- [x] После output validation отдельно отвергать `undefined` при объявленной
      schema, даже если schema его принимает.
- [x] Для endpoint с output всегда вызывать JSON serializer; `null` должен
      отправляться как `application/json` с телом `null`.
- [x] Для endpoint без output всегда строить bodyless `Response`; непустой
      handler/hook result должен давать contract violation независимо от
      явного body-capable status.
- [x] Сохранить HEAD/raw-response ветки без изменения ownership и body removal.

### 3. Tool transport parity

- [x] Проверить canonical tool runner на тот же output invariant: contract tool
      без output не должен публиковать случайно возвращённые данные, а output
      tool не должен принимать `undefined` как успешный model result.
- [x] Использовать общую проверку HTTP/MCP/Agent/CLI там, где это убирает
      расхождение без смешивания HTTP status с transport-neutral execution.
- [x] Сохранить существующий `{ status: 'ok' }` presentation для действительно
      empty tool result и nullable `null` для tool с nullable output.

### 4. Typed clients

- [x] Зафиксировать оба client paths — configured HTTP client и bare Fetch:
      `200` с JSON `null` возвращает именно `null` и проходит nullable output
      schema, а `204` no-output возвращает `undefined`.
- [x] Проверить explicit bodyless `205` для no-output endpoint: оба typed client
      path должны возвращать `undefined`, а не пытаться парсить пустой JSON.
- [x] Не использовать empty body/content-length как замену output contract при
      `200`: malformed declared-output response должен падать громко.

### 5. Definition boundaries и OpenAPI

- [x] Сохранить type-level и runtime definition-time запрет
      `output + responseMeta.status: 204 | 205`.
- [x] Сохранить defensive runtime проверку mutated/remote `MethodDef`, чтобы
      обход TypeScript не создавал несовместимую response definition.
- [x] Зафиксировать OpenAPI: любой endpoint с output документирует `200` либо
      явный body-capable 2xx и JSON schema; endpoint без output — `204` либо
      явный bodyless success без content.

### 6. Regression tests

- [x] `output: z.object(...).nullable()` + handler `return null` → `200`,
      `Content-Type: application/json`, body bytes равны `null`.
- [x] Та же schema + object → `200` и валидный JSON object.
- [x] Объявлен output, handler/hook вернул `undefined` →
      `INTERNAL_SERVER_ERROR`, включая schema, которая допускает undefined.
- [x] Нет output, handler вернул `undefined` или `null` → default `204`, пустое
      тело.
- [x] Нет output, handler/hook вернул непустые данные →
      `INTERNAL_SERVER_ERROR`, в том числе при explicit body-capable status.
- [x] Configured client и Fetch client различают nullable `null` и no-output
      `undefined` на Bun и Node adapters.
- [x] MCP/Agent runner соблюдает тот же declared-output invariant без изменения
      presentation semantics.
- [x] OpenAPI regression покрывает nullable output, ordinary output, no-output,
      explicit body-capable status и explicit `205` no-output.
- [x] Raw-response и `respondJson(null | undefined)` regression подтверждают,
      что их прежняя семантика не изменилась.

### 7. Документация и релиз

- [x] Обновить ADR 0052: default определяется output contract, а не
      `undefined`/`null`; nullable output является обычным JSON data endpoint.
- [x] Синхронизировать `docs/guide/server.md`, contracts/client guides и API
      reference, удалив формулировки `204 when null` для contract endpoints.
- [x] Добавить `[Unreleased]` changelog note с migration guidance: handler,
      возвращающий данные без output, обязан объявить schema; nullable data
      требует nullable output.
- [x] Перегенерировать consumer docs/LLM artifacts штатным build pipeline.
- [x] Прогнать полный `bun run verify`, включая Node smoke и consumer lane.

## Acceptance

- [x] Success status и наличие JSON body определяются output contract, а не
      runtime value.
- [x] Nullable output возвращает HTTP `200` с JSON `null`; typed clients получают
      `null`, не `undefined`.
- [x] Declared output + `undefined` и no-output + непустые данные громко падают
      как handler contract violations.
- [x] No-output endpoint сохраняет bodyless `204` default; explicit legal
      bodyless status корректно читается обоими clients.
- [x] OpenAPI, Bun, Node, configured client, Fetch client и tool transports
      согласованы с одной моделью.
- [x] Raw-response/HEAD/low-level JSON helpers не изменили семантику.
- [x] Документация, changelog и полный verify зелёные.

## Не входит

- Multi-response contracts, dynamic per-call status, content negotiation или
  новый response envelope.
- Изменение raw-response ownership, файловых/streaming endpoints и
  `respondJson()` как низкоуровневого helper.
- Commit, push, release и consumer migration.

## Что сделано

- [x] **Core invariant:** `packages/core/src/internal/errors.ts` теперь единообразно
      валидирует declared output для HTTP и tool runners.
- [x] **HTTP transport:** `packages/core/src/server/create.ts` выводит status/body
      из output-контракта; nullable `null` сериализуется как JSON, no-output
      остаётся bodyless.
- [x] **Tool transport:** `packages/core/src/tools/execute.ts` и
      `packages/core/src/tools/runtime-tool.ts` запрещают неописанные данные и
      типизируют no-output runtime handlers как `void`.
- [x] **Typed clients:** `packages/core/src/browser/client.ts` и
      `packages/core/src/browser/http.ts` различают JSON `null`, bodyless
      `undefined` и malformed responses по контракту.
- [x] **Definitions/OpenAPI:** запреты `output + 204/205` подтверждены на
      type/runtime boundary, а OpenAPI regression фиксирует `200` для output и
      `204` для no-output.
- [x] **Tests:** `packages/core/tests/output-contract-semantics.test.ts` и
      смежные suites покрывают Bun, Node, configured/bare clients, tools,
      raw helpers и response metadata; итог — 899 tests / 1912 assertions.
- [x] **Docs:** обновлены ADR 0052, server/contracts/client/upgrading guides,
      API reference, `[Unreleased]` changelog и generated LLM docs.
- [x] **Гейты:** `bun run verify` зелёный — lint, typecheck, tests, build,
      Node HTTP/Socket.IO smoke и consumer lane.
- [x] **Что НЕ делалось:** commit, push, release и миграция consumers не входят
      в эту задачу и не выполнялись.
