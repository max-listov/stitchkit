---
title: "Phase-safe composition для HTTP и tool lifecycle"
description: Типизированная композиция auth, policy, attribution и audit hooks с единым порядком, short-circuit и error semantics без смешивания HTTP и tool фаз.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 12:53 +00:00
---

# Composable lifecycle hooks

## Зачем

Consuming projects повторяют ручную сборку цепочек `auth → policy →
attribution/audit` отдельно для HTTP и MCP/Agent/CLI. Правила доменные, но
последовательное исполнение, short-circuit, result transformation и передача
cancellation — transport-механика Stitchkit. Ручные wrappers легко меняют
порядок, забывают одну surface или расходятся между HTTP и tools.

Один универсальный composer был бы неверной абстракцией: HTTP имеет
pre-body `authorize`, `onRequest` и `onError`, тогда как `ToolLifecycle` имеет
только `beforeHandle`/`afterHandle`. Нужны две phase-safe функции с общей
семантикой там, где фазы действительно совпадают.

## Результат

- `composeLifecycleHooks(...hooks: readonly (LifecycleHooks | undefined)[])`
  возвращает обычный `LifecycleHooks`.
- `composeToolLifecycle(...lifecycles: readonly (ToolLifecycle | undefined)[])`
  возвращает обычный `ToolLifecycle`.
- Для `onRequest`, `authorize` и `beforeHandle` компоненты выполняются в
  порядке объявления; первый `Response` в `onRequest` прекращает цепочку.
- `afterHandle` последовательно передаёт результат следующему hook в порядке
  объявления. Non-`undefined` return заменяет текущий result; `undefined`
  сохраняет его — точно как существующие одиночные HTTP/tool hooks.
- HTTP `onError` вызывается по порядку до первого возвращённого `Response`;
  `undefined` передаёт обработку следующему hook. Throw component hook
  останавливает composer; outer server сохраняет текущее поведение: fallback
  строится для исходной request error, а не повторно прогоняет ошибку самого
  `onError` через lifecycle.
- Каждому component передаются те же arguments, которые composer получил для
  конкретной phase, без клонирования или подмены. Если phase context содержит
  `signal`, сохраняется его object identity; composer не создаёт cancellation.
- Одна policy function может использоваться в разных совместимых slots, но
  binding остаётся явным: pre-body HTTP `{ authorize: policy }`, tools
  `{ beforeHandle: policy }`. Composer не превращает tool `beforeHandle` в HTTP
  `authorize` и не скрывает phase adapter.
- `AuthScopes<typeof authPolicy>` выводится из исходного marker-bearing auth
  hook до композиции: обычный `LifecycleHooks` result не обязан переносить
  `ScopedAuthHook['~scopes']`.
- Domain policies, identities, role models и error envelopes остаются кодом
  приложения; framework владеет только композицией.

## План

- [x] Добавить ADR, который уточняет/supersede соответствующую consequence ADR
      0004: вводится только narrow phase-local composition, не middleware engine;
      обновить индекс ADR.
- [x] Добавить чистый HTTP composer рядом с server lifecycle types и
      экспортировать из `stitchkit/server`.
- [x] Добавить чистый tool composer рядом с `ToolLifecycle` и экспортировать
      из `stitchkit/tools`.
- [x] Не объединять несовместимые фазы и не вводить общий loose hook type;
      structurally assignable shared hook object должен по-прежнему работать.
- [x] Определить обработку пустого списка и `undefined` entries: результат
      остаётся валидным no-op lifecycle, чтобы условные policies не требовали
      wrappers.
- [x] Ограничить composed `onError` root server slot: текущий router не исполняет
      `RouteGroup.hooks.onError`; не обещать несуществующую group semantics и не
      расширять её скрыто внутри этой задачи.
- [x] Добавить runtime tests для точного порядка каждой фазы, short-circuit,
      async hooks, `undefined`/non-`undefined` result transforms, `onError`
      fallthrough/first response, throw первого/второго component, пропуск
      оставшихся hooks и сохранения argument/signal identity там, где signal
      присутствует.
- [x] Закрепить outer-runtime edge cases: raw-response HTTP endpoint по-прежнему
      не запускает `afterHandle`; tool-side lifecycle throw достигает
      существующего `ToolCallHooks.onToolError`; error из composed HTTP
      `onError` получает текущий server fallback.
- [x] Добавить integration test, где одна policy chain проходит через HTTP и
      ToolLifecycle с явными phase-safe bindings и даёт одинаковый admission
      result, не утверждая равенство несовместимых error transports.
- [x] Добавить type tests: HTTP-only hook нельзя передать в tool composer через
      ослабленный тип; composed return сохраняет точные public interfaces;
      `AuthScopes` продолжает браться с исходного auth hook.
- [x] Обновить server/auth и MCP/Agent guide с одним рецептом общей policy
      chain, API reference, generated `llms` и `CHANGELOG.md`.
- [x] Добавить packed-consumer fixture для обоих exports. Релиз не входит.

## Acceptance

- [x] Consumer выражает цепочку из трёх независимых policies декларативно и
      использует shared policy code на HTTP и tools через явные phase-safe
      bindings без ручных orchestration wrappers.
- [x] Порядок и short-circuit закреплены тестами и документацией; ошибки не
      переинтерпретируются composer-ом, а outer-runtime fallback описан честно.
- [x] `undefined` из любого `afterHandle` сохраняет предыдущий result на HTTP и
      tools; component throw останавливает оставшуюся цепочку.
- [x] `authorize` остаётся pre-body и не может случайно получить tool/input
      semantics через общий loose composer.
- [x] Полученные phase arguments передаются по identity; если `ctx.signal`
      существует, сохраняется он же. Новые controllers/timers не создаются.
- [x] Existing root/group lifecycle ordering не меняется: composer определяет
      порядок только внутри одного lifecycle slot.
- [x] Group `onError` не заявлен как рабочий; raw-response и tool `onToolError`
      semantics не меняются.
- [x] `bun run verify` зелёный.

## Что сделано

- Добавлены phase-safe composeLifecycleHooks и composeToolLifecycle без общего loose hook type.
- Закреплены порядок, short-circuit, transform, error fallback и identity semantics; существующая root/group ownership не изменена.
- Обновлены ADR 0086, server/tool guides, API reference, changelog и packed consumer fixture.
- [x] Регрессия: packages/core/tests/lifecycle-compose.test.ts::runs request/authorize/before phases in declaration order; packages/core/tests/lifecycle-compose.test.ts::the first Response short-circuits onRequest; packages/core/tests/lifecycle-compose.test.ts::undefined afterHandle preserves the current result; packages/core/tests/lifecycle-compose.test.ts::onError falls through undefined and stops at the first Response; packages/core/tests/lifecycle-compose.test.ts::a thrown component stops the remaining phase and preserves signal identity; packages/core/tests/lifecycle-compose.test.ts::uses the same ordered transform semantics without HTTP phases; packages/core/tests/lifecycle-compose.test.ts::a thrown tool policy skips the remaining components
