---
title: Scope-aware URL builder registry
description: Строить typed URL registry по contract.meta.scope с теми же config routing и namespace composition guarantees, что createScopedClients
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 15:46 +00:00
related: docs/backlog/done/2026-08-07-scope-aware-composed-client-registry.md
---

# Scope-aware URL builder registry

## Источник

После перехода consuming application на `createScopedClients` request clients
используют единый scope registry, но URL builders всё ещё создаются по одному.
Один и тот же dynamic prefix config повторяется отдельно, хотя URL routing и
request routing принадлежат одному `contract.meta.scope`.

Названия и доменная модель consumer-а в публичном репозитории не фиксируются.

## Проблема

`createUrlBuilders` принимает один `ContractClientConfig` для всего registry.
Он не может выбрать разные `pathPrefix`/`stripPrefixKeys` по literal scope и не
умеет composed namespaces. Consumer повторно классифицирует contracts и
дублирует prefix config, создавая второй источник route truth.

## Целевая модель

Отдельный однозначный API симметричен `createScopedClients`:

```ts
const urls = createScopedUrlBuilders(
  {
    media: [publicMedia, tenantMedia],
    exports: exportsContract,
  },
  { baseUrl: '/api/' },
  {
    public: {},
    tenant: {
      stripPrefixKeys: ['tenantId'],
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    },
  },
)
```

Расширять `createUrlBuilders` неоднозначной overload-моделью не нужно:
single-config batch и scope-routed registry выражают разные input shapes.

## Инварианты

- Scope берётся только из `contract.meta.scope`.
- Все достижимые scopes обязательны типами; отсутствующий runtime config падает
  fail-first до выдачи URL.
- Consumed prefix keys требуются только методам соответствующего scope и не
  попадают в query/body.
- URL строится существующим `planClientRequest`; второго planner нет.
- Arrays объединяют contracts только в client-side namespace и отвергают
  duplicate method names.
- Любой HTTP method может получить URL, но non-URL arguments по-прежнему
  отклоняются существующим builder policy.

## План

### 1. Переиспользовать registry type model

- [x] Обобщить internal scope/namespace inference между scoped clients и URL
      builders без копирования сложных conditional types.
- [x] Вывести точный `ScopedUrlBuilder` для каждого исходного contract и scope config.
- [x] Поддержать composed namespace `contract | readonly contract[]`.

### 2. Runtime routing

- [x] Выбирать config по literal `contract.meta.scope`.
- [x] Делегировать `createUrlBuilder` и существующему request planner.
- [x] Fail-first для missing scope config, contract без scope и duplicate method.
- [x] Не хранить args или request-specific prefix state между calls.

### 3. Public surface и tests

- [x] Экспортировать один `createScopedUrlBuilders` и необходимые public types.
- [x] Покрыть root + dynamic scopes и composed namespace; отдельный parallel
      сценарий неприменим к синхронному pure URL builder без mutable call state.
- [x] Покрыть точную типизацию path/query/body/consumed prefix keys для GET,
      POST, DELETE, raw-response и HEAD operations.
- [x] Обновить client guide, API reference, generated llms и changelog.
- [x] Полный `bun run verify` зелёный: 890 tests, build, Node smoke и consumer lane.

## Acceptance

- [x] Consumer объявляет scope configs один раз для scoped URL registry.
- [x] Ручные per-contract URL builder configs удаляются.
- [x] URL-bound argument types остаются точными для каждого method.
- [x] Scope-aware clients и URL builders используют один routing/type model.

## Что сделано

- [x] **Type model:** `packages/core/src/browser/client.ts` переиспользует
      `RegistryContract`, `RegistryScope`, `PrefixKeys` и namespace intersection
      для exact `ScopedClientRegistry` и `ScopedUrlBuilderRegistry`.
- [x] **Runtime:** общий `buildScopedRegistry` маршрутизирует contracts по scope,
      объединяет namespaces и fail-first отклоняет missing config/duplicate method.
- [x] **URL planning:** `createScopedUrlBuilders` делегирует существующему
      `createUrlBuilder`/`planClientRequest`; второго planner или mutable cache нет.
- [x] **Public API:** функция и `ScopedUrlBuilderRegistry` экспортированы через
      `packages/core/src/index.ts`.
- [x] **Tests:** `packages/core/tests/scoped-url-builder-registry.test.ts` покрывает
      literal scopes, composed namespaces, GET/query, POST, multipart, DELETE,
      raw response, HEAD и compile-time URL-bound arguments.
- [x] **Docs:** обновлены client guide, API reference, changelog и generated
      `packages/core/llms*.txt`.
- [x] **Validation:** `bun run verify` прошёл — 890 tests, build, Node smoke и
      все consumer lanes зелёные.
- [x] **Не делалось:** ambiguous overload для `createUrlBuilders`, compatibility
      wrappers, commit, push, release и миграция внешних consumers.
