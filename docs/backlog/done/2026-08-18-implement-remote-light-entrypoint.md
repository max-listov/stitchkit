---
title: "Лёгкий экспорт implementRemote без MCP SDK"
description: Запрос потребителя: implementRemote живёт только в stitchkit/tools, который статически тянет @modelcontextprotocol/server и ai в CLI-бандл — нужен entrypoint/структура без этих peer-зависимостей.
type: task
status: done
created: 2026-08-18
updated: 2026-08-20
completed: 2026-08-20 13:57 +00:00
---

# implementRemote без MCP SDK в бандле

## Зачем

`implementRemote` нужен CLI-потребителю, но экспортируется только из
`stitchkit/tools`, статически тянущего `@modelcontextprotocol/server` и `ai`
в бандл. Проверить фактическую статичность (в socket-слое peers лениво —
возможно, tools просто не следует тому же паттерну) и либо перевести tools на
lazy-import, либо дать лёгкий entrypoint.

## Результат

- `implementRemote` имеет один канонический лёгкий entrypoint
  `stitchkit/remote`, чей eager graph не содержит MCP SDK, `ai` или других
  optional tool peers.
- Старый экспорт из `stitchkit/tools` удалён clean-cut миграцией: один symbol —
  один owner, без alias/shim.
- Packed consumer реально импортирует и bundle-ит `stitchkit/remote` при
  установленных только `stitchkit` + `zod`.

## План

- [x] Добавить `src/remote.ts`, package export, build/type/public-surface и Node
      entrypoint coverage; оставить implementation module peer-free.
- [x] Удалить `implementRemote`/`ImplementRemoteOptions` из `stitchkit/tools` и
      обновить все public examples на `stitchkit/remote`.
- [x] Добавить packed minimal-consumer probe: новый entrypoint build/load
      работает, существующие forwarding regressions зелёные, а bundle/metafile
      не содержит `@modelcontextprotocol/*` или `ai`.
- [x] Обновить API reference, upgrading guide и Unreleased breaking note с
      before → after import.
- [x] Прогнать полный `bun run verify`; релиз не входит.

## Acceptance

- [x] `import { implementRemote } from 'stitchkit/remote'` работает из packed
      tarball без установленных MCP/AI peers.
- [x] CLI/minimal bundle через новый entrypoint не включает MCP SDK или `ai`.
- [x] Старый tools import падает по public-surface/type regression, а migration
      документирована как breaking change.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Public boundary: `packages/core/src/remote.ts`, package exports/build,
      Node smoke и public declaration registry закрепляют единственный
      `stitchkit/remote`; tools barrel больше symbol не экспортирует.
- [x] Architecture/docs: `docs/decisions/0090-remote-implementation-has-a-peer-free-entrypoint.md`,
      entrypoint guide, MCP/Agent guide, upgrading guide, API reference и
      breaking changelog описывают clean-cut migration.
- [x] Packed gate: `packages/core/scripts/consumer-lane/fixtures/minimal/src/remote-bundle.ts`
      и steps `minimal: bundle remote entrypoint` / `minimal: run remote bundle`
      в `packages/core/scripts/consumer-lane/run.mjs` доказывают install/build/load
      без optional peers и проверяют metafile.
- [x] Surface snapshot: `packages/core/tests/reference-coverage.test.ts` checks
      the exact `stitchkit/remote` export list from
      `packages/core/tests/fixtures/public-surface.json`.
- [x] Регрессия: packages/core/tests/api-error-brand.test.ts::a foreign-chunk ApiError converts to AppError with code, status, hint and traceId
