---
title: Scope-aware composed client registry
description: Строить один typed API registry по contract scope и объединять несколько contracts в namespace без ручной классификации и facade
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 13:43 +00:00
---

# Scope-aware composed client registry

## Источник

Кросс-аудит реального consuming application на Stitchkit 0.38.0. Contract scope
уже записан в `contract.meta.scope`, но frontend повторно делит единый registry
по scopes, вызывает `createClients` несколько раз и вручную собирает итоговый
API. Логически единый namespace также приходится делить на несколько contracts,
когда его operations имеют разные scopes, а затем склеивать facade-ом.

Названия и доменная модель consumer-а в публичном репозитории не фиксируются.

## Проблема A — scope routing

Один `createClients` принимает один `ContractClientConfig`. При разных route
prefixes consumer повторно классифицирует contracts, хотя framework уже знает
их scope. Это создаёт второй registry и позволяет scope/client routing разойтись.

## Проблема B — namespace composition

Contract имеет один contract-level scope. Поэтому operations одного frontend
namespace с разной auth/scope семантикой живут в разных contracts. Текущий API
возвращает разные namespaces, а consumer вручную объединяет методы обратно.

## Целевая модель

Точный spelling определяется реализацией, но API обязан выражать обе операции:

```ts
const api = createScopedClients(
  {
    auth: [publicAuthContract, authenticatedAuthContract],
    users: usersContract,
    projects: projectsContract,
  },
  http,
  {
    public: {},
    client: {},
    bot: {
      stripPrefixKeys: ['botId'],
      pathPrefix: ({ botId }) => `bots/${botId}`,
    },
  },
)
```

Scope strings и consumed keys принадлежат consumer generic types; Stitchkit не
знает ролей, tenant-ов или доменных enum.

## Инварианты

- Contract перечисляется ровно один раз.
- Scope берётся из contract metadata, а не из имени registry key.
- Один существующий request planner строит URL/body/multipart.
- Scope config consumed keys обязательны только у methods этого scope и не
  попадают в query/body.
- Неизвестный или отсутствующий scope fail-first; root fallback запрещён.
- Composition существует только на client surface и не создаёт новый server
  contract с потерянной identity.

## План

### 1. Type model scope registry

- [x] Вывести union scopes из входного contract registry.
- [x] Потребовать config для каждого достижимого scope и отвергать лишние /
      неизвестные scopes понятной compile-time формой.
- [x] Для каждого scope вывести собственный `ContractClientConfig<K>` и добавить
      его consumed keys только к соответствующим endpoint args.
- [x] Сохранить точные output, raw `Response`, multipart file и zero-arg method types.

### 2. Runtime routing

- [x] Выбирать config по `contract.meta.scope` и делегировать существующему
      `createClient`/`planClientRequest`.
- [x] Проверять отсутствующий config, invalid scope, duplicate contracts и
      dynamic prefix keys до первого сетевого запроса.
- [x] Не кешировать request-specific prefix либо args между параллельными calls.

### 3. Namespace composition

- [x] Разрешить registry value `contract | readonly contract[]` либо отдельный
      equally typed composition primitive — выбрать один чистый public path.
- [x] Объединить endpoint methods нескольких contracts в один typed namespace,
      сохраняя scope каждого исходного contract.
- [x] Duplicate method names отклоняются fail-first runtime guard-ом; отдельное
      compile-time доказательство отклонено как несоразмерное усложнение public типов.
- [x] Не переименовывать методы и не встраивать domain facade mappings в framework.

### 4. Совместимость public surface

- [x] Определить, заменяет ли новый API `createClients` или является отдельным
      primitive. Не оставлять две равноправные модели, если одна полностью
      покрывает другую.
- [x] Breaking consolidation отклонён: `createScopedClients` добавлен как composition
      primitive поверх существующего single-config `createClients`.
- [x] Экспортировать public types, обновить client guide, reference, generated
      llms и changelog.

## Tests

- [x] Root + два dynamic scopes в одном registry.
- [x] Consumed key требуется только соответствующему scope.
- [x] Consumed keys не уходят в query/body/multipart.
- [x] Один namespace из contracts разных scopes.
- [x] Duplicate method, unknown scope, missing config и typo fail-first.
- [x] Exact type preservation для GET/body/multipart/rawResponse/responseMeta.
- [x] SSR/browser clients и parallel calls.
- [x] Полный `bun run verify` зелёный: 856 tests, build, Node smoke и consumer lane.

## Acceptance

- [x] Consumer объявляет contract registry один раз.
- [x] Ручного разбиения registry по scope больше не требуется.
- [x] Логический namespace не требует consumer facade только из-за разных scopes.
- [x] Framework остаётся scope/domain-agnostic и использует один request planner.

## Что сделано

- [x] Browser API: `createScopedClients` добавлен в `packages/core/src/browser/client.ts`.
- [x] Types: scope-specific configs и composed registry экспортированы через
      `packages/core/src/index.ts`.
- [x] Runtime: contracts маршрутизируются по `meta.scope`, namespaces объединяются,
      duplicate methods и отсутствующие configs падают до сетевого запроса.
- [x] Tests: runtime и compile-time сценарии покрыты в
      `packages/core/tests/scoped-client-registry.test.ts`.
- [x] Docs: обновлены `docs/guide/client.md`, `docs/api/reference.md`, generated
      `packages/core/llms*.txt` и `CHANGELOG.md`.
- [x] Validation: полный `bun run verify` прошёл — 856 tests, build, Node smoke и
      consumer lane зелёные.
- [x] Не делалось: commit, push, release, deploy и миграция внешних consumers.
