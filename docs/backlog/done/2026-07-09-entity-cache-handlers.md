---
title: createEntityCacheHandlers — generic CRUD cache-updater для stitchkit/react
description: Декларативные merge-правила created/updated/deleted → list + infinite + detail для TanStack Query cache. Две почти идентичные реализации у потребителей. НЕ реализовывать по дизайну на бумаге — извлекать после сравнения живых копий.
type: task
status: done
created: 2026-07-09
updated: 2026-07-10
completed: 2026-07-10 04:35 +08:00
---

# `createEntityCacheHandlers` — CRUD cache-updater (React)

## Зачем

Два потребителя держат почти идентичный hand-rolled entity-cache-updater:
события `created` / `updated` / `deleted` → merge в list-, infinite- и
detail-кэши TanStack Query. Кандидат в `stitchkit/react` рядом с
`createCacheBridge`:

```ts
createEntityCacheHandlers({ entity, listKeys, detailKey, compare })
// → готовые merge-правила для createCacheBridge
```

## Почему НЕ сейчас (осознанно)

- Напряжение с ADR 0008 (thin wrappers): `createCursorQuery`/`createCacheBridge`
  тонкие и transport-agnostic, а CRUD-merge несёт мнения — форма entity
  (id-поле), конвенция ключей, семантика конфликтов merge.
- Копий пока **две** — правило трёх формально не сработало.
- Порядок: третья реализация дозревает у мигрирующего потребителя → diff двух
  живых копий → если семантика реально совпадает, извлекаем **проверенный** API,
  а не спроектированный на бумаге.

Рядом же посмотреть паттерн optimistic-мутаций с rollback через effects-DSL
(`createCacheMutation` у одного из потребителей) — тот же принцип: сначала
пощупать на живом, потом поднимать в пакет.

## Триггер

Миграция a consuming project на stitchkit завершена + его cache-updater
сравнён с существующим у второго потребителя.

## Подтверждение вторым источником (2026-07-09)

Агент на живой миграции прислал ровно это (`createEntityHandlers`/`createCrudHooks`
поверх `createQuery`/`createCursorQuery`/`createMutation`, ~14 хуков с
повторяющимся обвесом list/get/create/update/delete + инвалидация) — **и сам
поставил ту же оговорку**, что записана выше: не прятать флэттинг страниц, не
тянуть `useAllX`-стиль (флэттинг держат В КОМПОНЕНТЕ). Два независимых анализа
сошлись и на фиче, и на её ограничении → сигнал сильный, но осторожность та же:
извлекать по живым данным, не на бумаге.


## Реализовано (0.19.0)

Вышло в релизе 0.19.0. Код + тесты + доки + reference. Файл перенесён в done/.
