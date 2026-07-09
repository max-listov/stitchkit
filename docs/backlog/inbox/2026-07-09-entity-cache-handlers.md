---
title: createEntityCacheHandlers — generic CRUD cache-updater для stitchkit/react
description: Декларативные merge-правила created/updated/deleted → list + infinite + detail для TanStack Query cache. Две почти идентичные реализации у потребителей. НЕ реализовывать по дизайну на бумаге — извлекать после сравнения живых копий.
type: task
status: inbox
created: 2026-07-09
updated: 2026-07-09
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
