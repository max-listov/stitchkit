---
title: Contract surface polish для JSON, webhooks и no-auth MCP
description: Убрать ложный free-form debt, прояснить raw boundary и упростить сборку MCP без auth.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 13:47 +00:00
---

# Contract surface polish

## Зачем

Три маленьких шероховатости создают неверные consumer patterns:

1. намеренный JSON описывают через untyped schema и строковый `allowUntyped`, хотя
   Zod v4 уже имеет точный `z.json()`;
2. signed JSON webhook уже contract-native через `rawBody: true`, но граница с
   настоящим `RawRoute` недостаточно заметна;
3. no-auth MCP server требует косметический `buildMcpServer(config, undefined)`.

Для них не нужны новые transport abstractions — достаточно привести подсказки,
документацию и overload к уже существующему канону.

## Результат

- Arbitrary JSON объявляется через `z.json()` и проходит strict MCP schema gate
  без path allowlist.
- Документация однозначно показывает, когда использовать contract + `rawBody`, а
  когда настоящий `RawRoute`.
- `buildMcpServer(config)` компилируется для конфигурации без auth; auth-required
  конфигурация по-прежнему требует второй аргумент.

## План

- [x] Добавлен generic regression: `z.json()` конвертируется в portable recursive
  JSON Schema, а `findUntypedProperties()` возвращает пустой результат.
- [x] Обновлены strict schema diagnostics: для намеренного arbitrary JSON
  рекомендовать `z.json()`; `allowUntyped` оставить только для действительно
  непредставимых presentation values.
- [x] Free-form пример с path allowlist в MCP guide заменён на `z.json()`;
  описать разницу между JSON value и unknown runtime value.
- [x] Добавлена компактная decision table для HTTP boundaries: обычный contract,
  signed JSON contract с `rawBody`, multipart contract, binary `rawResponse` и
  настоящий raw route.
- [x] Новый webhook helper не добавлен; существующие headers,
  `rawBody`, `maxJsonBodyBytes`, input validation и HTTP-only exposure одним
  целым примером.
- [x] Добавлен overload `buildMcpServer(config)` только когда auth type допускает
  отсутствие значения; не ослаблять типы auth-required lifecycle/context.
- [x] No-auth и auth-required формы покрыты compile fixtures и runtime tests.
- [x] API reference, changelog и generated llms docs обновлены штатным генератором.

## Не входит

- Новый `freeFormJson()` wrapper поверх `z.json()`.
- Provider-specific webhook verification.
- Contract-level cookie metadata.
- Compatibility aliases или второй MCP builder.

## Acceptance

- [x] `z.json()` не требует `allowUntyped` при strict MCP schema validation.
- [x] Реально untyped `{}` по-прежнему обнаруживается и не маскируется новой
  подсказкой.
- [x] Guide позволяет выбрать contract/raw boundary без знания внутреннего router.
- [x] `buildMcpServer(config)` работает для no-auth server.
- [x] Пропуск обязательного auth остаётся compile-time ошибкой.
- [x] Явный `buildMcpServer(config, auth)` работает без изменения semantics.
- [x] Полный `bun run verify` зелёный.

## Что сделано

- [x] **Schema diagnostics:** `packages/core/src/tools/mcp-prepare.ts` рекомендует
  `z.json()` для намеренного JSON вместо строкового debt allowlist.
- [x] **Schema tests:** `packages/core/tests/untyped-properties.test.ts` проверяет
  portable recursive JSON presentation, пустой `findUntypedProperties()` и
  сохранённое обнаружение настоящего untyped `{}`.
- [x] **MCP builder:** `packages/core/src/tools/mcp.ts` содержит no-auth overload
  без ослабления auth-required формы.
- [x] **MCP tests:** `packages/core/tests/mcp-no-auth-builder.test.ts` покрывает
  `builds without a positional auth argument when auth is absent` и
  `keeps explicit auth bound to auth-required configurations`, включая
  compile-negative пропуск auth.
- [x] **Docs:** `docs/guide/mcp-and-agents.md` документирует `z.json()`;
  `docs/guide/server.md` содержит decision table для contract, signed JSON,
  multipart, raw response и true raw route; обновлены `docs/api/reference.md` и
  `CHANGELOG.md`.
- [x] **Что не делалось:** новые JSON/webhook wrappers, provider-specific logic и
  cookie metadata не добавлялись; release, commit, push и deploy не выполнялись.
