---
title: Entity cache handlers for real list shapes
description: Расширить createEntityCacheHandlers для plain arrays, dynamic scoped keys, projections и sorting без превращения helper в доменный cache framework
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 14:28 +00:00
---

# Entity cache handlers for real list shapes

## Источник

Кросс-аудит consuming application: `createCacheBridge` используется, но рядом
сохраняется локальный CRUD updater. Текущий `createEntityCacheHandlers` владеет
только `Paginated<T>` и `InfiniteData<Paginated<T>>`; реальный consumer также
имеет plain arrays, bot-scoped dynamic keys, full-entity→list-item projection и
обязательную сортировку, совпадающую с backend `orderBy`.

Это перспективная generic extraction, но не автоматический мандат на разрастание
API. Если representative fixtures показывают, что чистой малой модели нет,
задачу следует закрыть аргументированным отказом, а не универсальным callback soup.

## Инварианты

- `createCacheBridge` остаётся transport-agnostic и optional convenience.
- Cache helper не знает bot/project/workspace/domain names.
- Backend ordering не выводится эвристикой; consumer передаёт comparator явно.
- Plain, paginated и infinite shapes сохраняют собственные envelopes/pageParams.
- Fresh mutation echo guard работает одинаково для всех adapters.

## Выбранная модель после проверки fixtures

- Один `createEntityCacheHandlers<TData, TListItem>` остаётся единственным API;
  старой параллельной ветки нет.
- `list.shape` — built-in discriminant: `array`, `paginated`,
  `infinite-array`, `infinite-paginated`. Отдельный exported adapter добавил бы
  public abstraction без дополнительной выразительности.
- `list.key` и `detailKey` принимают static `QueryKey` либо один typed event
  selector над discriminated `created | updated | deleted` payload.
- `getId`, `getListItemId` и `toListItem` явны: projection не маскируется cast-ом
  или structural guess.
- `createAt: start | end` выбирает insertion page/edge; `updateMissing: skip |
  insert` делает отсутствие item явной политикой.
- `compare` сортирует затронутый logical item-array. Infinite page boundaries,
  pageParams и envelope metadata не переписываются и не выводятся эвристикой.

## План

### 1. Проверка модели

- [x] Собрать test fixtures для `T[]`, `Paginated<T>`,
      `InfiniteData<Paginated<T>>` и page-as-array infinite data.
- [x] Проверить минимальную модель list adapter-а: чтение items, запись items и
      created insertion policy без утечки TanStack internals в domain config.
- [x] Сравнить две формы API: discriminated built-in `listShape` против
      отдельного exported adapter. Выбрать меньшую и типобезопасную.

### 2. Scoped keys и data projection

- [x] Разрешить list/detail key factory от event payload/entity, сохранив
      статический key как простой путь.
- [x] Разделить `TData` и `TListItem`; добавить typed `toListItem` для create/update.
- [x] Добавить optional comparator и детерминированную re-sort после create/update.
- [x] Явно определить update отсутствующего item: skip или insert, без скрытого
      поведения, зависящего от list shape.

### 3. CRUD semantics

- [x] Deduplicate create по canonical `getId` во всех страницах.
- [x] Update/delete применять ко всем cached pages, detail cache обновлять один раз.
- [x] Created insertion для infinite data затрагивает только выбранную page
      policy и не меняет pageParams/total молча.
- [x] Сохранить custom `getDeletedId` и `ctx.isFresh`.

### 4. Public API и миграция

- [x] Не оставлять параллельные legacy/new helpers. Если чистый API требует
      breaking signature, оформить minor pre-1.0 migration по правилам проекта.
- [x] Обновить realtime guide, API reference, generated llms и changelog.
- [x] Добавить пример dynamic workspace key + projected/sorted list без названий
      реальных consumers.

## Tests

- [x] CRUD matrix для каждого поддержанного list shape.
- [x] Dynamic keys не обновляют соседний scope.
- [x] Projection и comparator сохраняют list item type/order.
- [x] Infinite pages/pageParams и pagination metadata не повреждаются.
- [x] Fresh echo, duplicate create, missing update и deleted-id payload.
- [x] Compile-time inference без `as` в consumer fixture.
- [x] Полный `bun run verify` зелёный: 884 tests, build, Node smoke и consumer lane.

## Acceptance

- [x] Реальный generic CRUD updater выражается небольшой декларативной config.
- [x] Helper не содержит domain model и не заменяет произвольный `setQueryData`.
- [x] Все поддержанные cache shapes типобезопасны и сохраняют metadata.
- [x] Conditional rejection рассмотрен и отклонён: fixtures подтвердили clean
      built-in discriminant без exported callback adapter.

## Что сделано

- [x] **React core:** `packages/core/src/react/entity-cache.ts` теперь поддерживает
      array, paginated и обе infinite формы одним declared shape switch.
- [x] **Keys:** static keys и typed event selectors разрешают scoped list/detail
      caches; runtime shape guards не патчат соседние detail values под prefix.
- [x] **Projection:** `TData → TListItem`, отдельные canonical id readers,
      comparator и explicit create/missing-update policies полностью типизированы.
- [x] **CRUD:** create dedupe проверяет все страницы; update/delete проходят все
      pages; infinite insertion меняет одну edge page и сохраняет metadata.
- [x] **Public API:** новые event/key/list types экспортированы из
      `packages/core/src/react.ts`; legacy signature удалена без shim.
- [x] **Tests:** `packages/core/tests/entity-cache.test.ts` содержит CRUD matrix,
      scope isolation, projection/order, metadata, echo и deleted-id cases.
- [x] **Consumer lane:** packed external fixture компилирует и исполняет scoped
      projected array config без assertions.
- [x] **Docs:** realtime guide, API reference, upgrading, changelog, generated
      llms и ADR 0056 синхронизированы.
- [x] **Не делалось:** helper не меняет totals/cursors, не выводит comparator и
      не заменяет arbitrary TanStack `setQueryData`.
