---
title: Node-поддержка — полировка (type-leak, Biome-guard, доки)
description: Три некритичных остатка после закрытия runtime-agnostic-ядра. Node уже полноценно работает; это polish — убрать утечку Bun-типов из .d.ts, добавить Fetch-purity Biome-guard, дописать Node-доки (serveNode в getting-started + deployment).
type: task
status: inbox
created: 2026-06-05
updated: 2026-06-05
related: docs/backlog/done/2026-05-20-runtime-agnostic-core.md
---

# Node-поддержка — полировка (остатки runtime-agnostic-ядра)

> **Вынесено из** [`runtime-agnostic-core`](../done/2026-05-20-runtime-agnostic-core.md)
> при его закрытии. Само ядро (Node работает, verified, зашипано в 0.3.0) —
> done. Эти три пункта — некритичный polish, Node ими не блокируется. На потом.

## Item 1 — Утечка `Bun`-типов в `/server` + `/node` `.d.ts` (Ф3)

**Приоритет: P3 (DX/типы). Не блокер рантайма.**

`server/types.ts`: `RawRouteContext.server: BunServer` и
`export type BunServer = ReturnType<typeof Bun.serve>` → имя `Bun` течёт в
эмитируемые `.d.ts` барреля `stitchkit/server` (и транзитивно `/node`).
Node-консьюмер без `@types/bun` ловит `TS2503: Cannot find namespace 'Bun'`.

- **Сейчас смягчено:** `@types/bun` объявлен optional-peer — поставивший его
  Node-юзер не страдает. Но чистого нейтрального `.d.ts` нет.
- **Фикс:** `RawRouteContext<TServer = unknown>` generic; `BunServer` не светить
  в нейтральном шве (Bun-консьюмер получает конкретный тип через `createServer`).
- **Файлы:** `packages/core/src/server/types.ts`, `server/index.ts` (ре-экспорт
  `BunServer`), `server/create.ts` (2-й параметр `server?: BunServer`).

## Item 2 — Biome Fetch-purity guard (Ф4)

**Приоритет: P3 (анти-регрессия). Сейчас есть рантайм-гарантия (dist-smoke).**

Нет lint-правила, банящего глобал `Bun` в Fetch-чистых директориях
(`contract`/`tools`/`react`/`observability` + `createHandler`). `biome.json`
сейчас наоборот объявляет `"globals": ["Bun"]` (разрешает везде).

- **Почему отложено:** формат `noRestrictedGlobals` под вопросом, риск сломать
  lint-гейт; `bun run smoke:node` (импорт всех server-entrypoints под node +
  serveNode/Socket.IO round-trip в CI) уже даёт рантайм-гарантию против утечки
  Bun-глобала в Node-путь.
- **Фикс:** path-scoped Biome override с `noRestrictedGlobals` (бан `Bun`) на
  core-директории. Проверить, что не ломает легитимные `Bun.*` в
  `create.ts`/`socket-io.ts`/`router.ts` (они вне «чистых» дир).

## Item 3 — Node-доки: `serveNode` в getting-started + deployment (Ф5)

**Приоритет: P3 (docs).**

`docs/guide/getting-started.md` упоминает Node только строкой в prerequisites
(«Node ≥ 22 supported via `stitchkit/node`») — **нет примера `serveNode`**.
`docs/guide/testing-and-deployment.md` — только предупреждение, что Bun-only код
не пойдёт на Node; **нет секции деплоя на Node**. Единственный реальный
`serveNode`-пример — в `realtime.md` (про сокеты).

- **Фикс:** в getting-started — короткий Node-вариант запуска (`serveNode`
  рядом с `createServer`); в testing-and-deployment — секция «Deploy on Node»
  (serveNode + `engines`/`@types/bun` peer + `transports:['websocket']` для
  Socket.IO на Node). `staticRoute` помечать Bun-only (статика на Node — через
  фронт/CDN).

## Ссылки

- Исходный таск: [`docs/backlog/done/2026-05-20-runtime-agnostic-core.md`](../done/2026-05-20-runtime-agnostic-core.md).
- ADR 0013 (runtime-agnostic core) — `docs/decisions/0013-runtime-agnostic-core.md`.
- Код: `packages/core/src/server/types.ts`, `server/index.ts`, `server/create.ts`,
  `biome.json`, `docs/guide/{getting-started,testing-and-deployment}.md`.
