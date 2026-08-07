---
title: Preserve literal scope in createContractFactory
description: Сохранять конкретный contract scope literal вместо расширения до полного allowed union приложения
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 15:42 +00:00
related: docs/backlog/done/2026-07-09-scoped-contract-factory.md
---

# Preserve literal scope in `createContractFactory`

## Источник

Compile-time аудит consuming application показал, что
`createContractFactory<TAllowedScope>()` проверяет allowed union, но возвращает
каждому контракту `ContractDef<T, TAllowedScope>`. Конкретный literal из
`meta.scope` теряется, поэтому scope-aware registries больше не могут выбрать
точный config без consumer wrapper.

Названия и scope vocabulary consumer-а в публичном репозитории не фиксируются.

## Корень

Текущий `ScopedDefineContract<TScope>` generic только по endpoints. Параметр
`meta.scope` имеет тип всего allowed union и тот же union попадает в return type.
Runtime реализация сохраняет строку корректно; дефект находится только в public
type signature.

## Целевая сигнатура

```ts
type ScopedDefineContract<TAllowedScope extends string> = <
  const TScope extends TAllowedScope,
  const T extends Record<string, EndpointDef>,
>(
  meta: { prefix: string; scope: TScope; meta?: Record<string, unknown> },
  endpoints: T,
) => ContractDef<T, TScope>
```

## План

- [x] Исправить `ScopedDefineContract`, сохранив literal `TScope` в return type.
- [x] Не ослаблять обязательность scope и allowed-union constraint.
- [x] Проверить, что factory runtime продолжает форвардить весь contract meta.
- [x] Добавить compile-time tests для двух literals одного allowed union.
- [x] Доказать, что missing scope и unknown literal не компилируются.
- [x] Доказать интеграцию с `createScopedClients`; URL registry покрывается
      следующей отдельной задачей `2026-08-07-scope-aware-url-builder-registry.md`.
- [x] Обновить changelog; docs менять только если описанная inference гарантия
      сейчас отсутствует или неверна.
- [x] Полный `bun run verify` зелёный: 887 tests, build, Node smoke и consumer lane.

## Acceptance

- [x] Контракт со scope `'alpha'` имеет тип `ContractDef<…, 'alpha'>`, а не
      `ContractDef<…, 'alpha' | 'beta'>`.
- [x] Consumer использует одну строку `createContractFactory<AllowedScope>()`
      без собственного generic wrapper.
- [x] Runtime behavior и emitted declarations остаются Fetch-clean и Node-safe.

## Что сделано

- [x] **Types:** `packages/core/src/contract/factory.ts` добавляет отдельный
      literal generic и возвращает `ContractDef<T, TContractScope>`.
- [x] **Runtime:** factory implementation не менялась и продолжает форвардить
      validated endpoints и весь contract meta.
- [x] **Tests:** `packages/core/tests/contract-factory.test.ts` проверяет два
      literals, required/allowed scope constraints и `createScopedClients` inference.
- [x] **Docs:** обновлены contract guide, API reference, changelog и generated
      `packages/core/llms*.txt`.
- [x] **Validation:** `bun run verify` прошёл — 887 tests, build, Node smoke и
      все consumer lanes зелёные.
- [x] **Не делалось:** runtime routing changes, compatibility wrappers, commit,
      push, release и миграция внешних consumers.
