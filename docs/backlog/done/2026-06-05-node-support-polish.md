---
title: Node-поддержка — чистые .d.ts и Fetch-purity guard
description: Remove Bun namespace leakage from Node-facing declarations and add a static guard that forbids Bun globals in runtime-neutral source.
type: task
status: done
created: 2026-06-05
updated: 2026-08-07
related: docs/backlog/done/2026-05-20-runtime-agnostic-core.md
completed: 2026-08-07 07:13 +00:00
---

# Node-поддержка — полировка (остатки runtime-agnostic-ядра)

> **Target release:** 0.37.0. Only Item 1 and Item 2 remain; the Node docs from
> Item 3 already shipped and are outside this implementation pass.

> **Вынесено из** [`runtime-agnostic-core`](../done/2026-05-20-runtime-agnostic-core.md)
> при его закрытии. Само ядро (Node работает, verified, зашипано в 0.3.0) —
> done. Эти три пункта — некритичный polish, Node ими не блокируется. На потом.

> **Статус (2026-06-05):** **Item 3 (Node-доки) — СДЕЛАН** в 0.6.0-проходе
> («разгрести инбокс»): `serveNode` в `getting-started.md` (новый «#### On Node»)
> и `testing-and-deployment.md` (новая секция «Deploy on Node» + поправлена
> неверная строка «a Node host will not run it» + `@types/bun` peer +
> `transports:['websocket']` + пометка Bun-only хелперов `serveFile`/raw-lane,
> `staticRoute` — dual-runtime). **Item 1 и Item 2 — осознанно отложены:**
> Item 1 (generic `RawRouteContext`) инвазивен — ломает cast-free
> `ctx.server.upgrade` в `socket-io.ts`; Item 2 (Biome Fetch-purity guard) сам
> помечен «риск сломать lint», а `smoke:node` уже даёт рантайм-гарантию. Таск
> остаётся в инбоксе ради Item 1/2.

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

## Item 3 — Node docs (complete)

The `serveNode` getting-started and deployment documentation shipped in the
0.6.0 pass. It stays out of this task; implementation must not rewrite it unless
the public type cleanup changes an example.

## Implementation plan

1. Trace every exported declaration reachable from `stitchkit/node` and the
   runtime-neutral handler surface; pin the current `Bun` namespace leak with a
   minimal consumer fixture that has no `@types/bun`.
2. Make the raw/fetch context server type generic at the neutral boundary,
   defaulting to `unknown`. Keep the concrete `BunServer` type only on Bun-owned
   APIs such as `createServer`; update all call sites without casts.
3. Add a declaration-level consumer test proving `stitchkit/node` typechecks in
   a Node-only fixture and that Bun consumers still receive the concrete server
   type where Bun owns the API.
4. Add a path-scoped static guard for runtime-neutral directories and
   `createHandler`. If the installed Biome version cannot express the rule
   precisely, implement one repository check script and include it in `lint` or
   `build`; do not weaken the boundary or suppress findings.
5. Update the API reference/JSDoc if the public generic surface changes and add
   the additive change under the 0.37.0 changelog entry.

## Acceptance

- [x] A Node-only consumer imports and uses `stitchkit/node` without installing `@types/bun`
- [x] Bun-owned entrypoints retain their concrete `BunServer` typing
- [x] Runtime-neutral source fails a repository gate when a `Bun` global is introduced
- [x] The guard excludes only the explicitly Bun-owned implementation files
- [x] No casts, suppression comments or duplicate server-context types are introduced
- [x] Existing Node smoke and consumer lanes remain part of the final `bun run verify` gate

## Ссылки

- Исходный таск: [`docs/backlog/done/2026-05-20-runtime-agnostic-core.md`](../done/2026-05-20-runtime-agnostic-core.md).
- ADR 0013 (runtime-agnostic core) — `docs/decisions/0013-runtime-agnostic-core.md`.
- Код: `packages/core/src/server/types.ts`, `server/index.ts`, `server/create.ts`,
  `biome.json`, `docs/guide/{getting-started,testing-and-deployment}.md`.

## Что сделано

- [x] **Runtime boundary:** `packages/core/src/server/bun.ts` now owns
      `Bun.serve`, its config and concrete aliases; `server/create.ts` is a
      generic Fetch-only handler with no Bun global or Bun declaration.
- [x] **Single context model:** `RawRoute`, `RawRouteContext`, `HandlerConfig`,
      `FetchHandler` and `FetchComposition` take one host-server generic.
      `stitchkit/server` binds it to `BunServer`; `stitchkit/node` defaults it to
      `unknown` without a duplicate context type.
- [x] **Node Socket.IO declarations:** `server/socket-io-node.ts` exposes only
      the Node capabilities (`io`, `attach`) while sharing one config schema;
      the Node declaration graph no longer reaches the Bun engine.
- [x] **Static guard:** `biome.json` rejects the `Bun` global across core source
      except `server/bun.ts` and `server/file.ts`. A temporary probe under
      `tools/` failed with `lint/style/noRestrictedGlobals`, then was removed.
- [x] **Consumer/gates:** a third packed fixture under
      `packages/core/scripts/consumer-lane/fixtures/node` installs Node peers
      without `@types/bun` and runs strict declaration checking. Lint, typecheck,
      34 Bun server/Socket.IO tests, build, Node HTTP/Socket.IO smoke and all
      three packed consumers are green.
- [x] **Docs:** API reference, Node deployment guide, changelog and generated
      LLM docs describe the runtime-specific type surfaces and migration.
