---
title: Docs — meta: declare as type/literal/satisfies, not interface
description: EndpointDef.meta (Record<string,unknown>) не принимает TS interface (нет implicit index signature) — ошибка ещё и маскируется под "scope mismatch" на overload defineContract. Тип НЕ меняем (3 Opus-агента единогласно). Чиним discoverability доками. DOC.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 01:00
related: docs/decisions/0021-endpoint-meta-passthrough.md, docs/backlog/inbox/2026-06-05-stitchkit-post-migration-batch.md
---

# Docs — meta: `type`/literal/`satisfies`, не `interface`

**Тип работы: DOC (только документация, тип не трогаем).** Решение принято после
3 независимых Opus-агентов — **единогласно вариант A** (оставить
`Record<string, unknown>`, задокументировать идиому).

## Проблема (discoverability, не дефект типа)

`EndpointDef.meta?: Record<string, unknown>`. TS **`interface`** не присваивается к
`Record<string, unknown>` (нет implicit index signature — interface открыт к
declaration merging). `type`-alias, inline-литерал и `x satisfies Iface` —
присваиваются. Хуже: на overloaded `defineContract` ошибка **маскируется** —
вылезает как «`scope` is missing / not allowed», уводя в неверное место.

## Почему НЕ меняем тип (итог 3 агентов)

- **B (`meta?: object`)** — ломает cast-free read `endpoint.meta?.x` в хуках (→
  `'x' in meta` на каждом чтении) + пускает массивы/функции. Net negative.
- **C (generic `createContract<TMeta>`)** — типизация write НЕ доходит до read-сайта
  (хуки видят базовый `MethodDef`), большой generic-thread ради одного консьюмера;
  ADR 0021 это уже отложил. Преждевременно.
- `Record<string, unknown>` = house style (6 мест с `[key:string]:unknown`),
  лучший read, честная opacity. Реальный дефект — только discoverability ошибки.

## Что сделать (DOC)

- [x] `docs/guide/contracts.md` (секция Endpoint metadata) — gotcha-блок: declare
      meta как `type` / inline-литерал / `satisfies`, **не `interface`**; показать
      broken→fixed (`interface`→`type`) и `satisfies`-форму.
- [x] ADR 0021 → Consequences: bullet про interface-vs-Record + почему `Record`
      оставлен над `object`/generic (pre-empt будущих «давайте object»).
- [x] JSDoc на `EndpointDefBase.meta` (`contract/define.ts`) — одна строка-подсказка
      «declare as `type`/inline, not `interface`» (фикс на ховере, на write-сайте).
- [x] `bun run verify` зелёный.

## Почему не сейчас

Коммиты в стич на паузе до конца миграции; идёт в батч 0.6.0. Консьюмер уже
разблокирован (`interface`→`type`, 1 слово).

## Что сделано (2026-06-05)

- [x] `docs/guide/contracts.md` — gotcha-блок в секции Endpoint metadata.
- [x] ADR 0021 → Consequences: bullet (interface-vs-Record + почему не `object`/generic).
- [x] JSDoc на `EndpointDefBase.meta` (`contract/define.ts`).
- [x] CHANGELOG `[Unreleased]`.
- [x] `bun run verify` зелёный (360 tests).

Реализовано в рабочем дереве; коммитится с релизом 0.6.0.
