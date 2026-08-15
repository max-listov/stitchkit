---
title: Синхронизировать актуальные docs и обе release-линии
description: Выпустить package docs без удалённого lifecycle API и актуальный create-stitchkit поверх последнего Stitchkit patch.
type: task
status: in-progress
created: 2026-08-15
updated: 2026-08-15
related: docs/backlog/done/2026-08-15-shutdown-force-completion-and-release-gates.md
---

# Синхронизировать актуальные docs и обе release-линии

## Зачем

`stitchkit@0.49.1` уже содержит canonical managed shutdown, а starter source и
lock используют тот же API. Но live guide всё ещё публикует устаревший
hardcoded test count через `llms-full.txt`, а накопленные starter changes лежат
в `[Unreleased]` и отсутствуют в последнем `create-stitchkit@0.3.0`. Нужны две
последовательные независимые patch-линии без compatibility shim и без
расхождения npm, GitHub Release, catalog target и package docs.

## Результат

- Последний npm `stitchkit` содержит актуальные generated agent docs и только
  canonical managed server lifecycle в current-facing примерах.
- Последний npm `create-stitchkit` генерирует starter, locked на последний
  опубликованный Stitchkit patch и использующий один managed shutdown owner.
- Исторические migrations остаются в changelog/upgrading, а active MCP
  protocol-era policy не выдаётся за удалённый или deprecated server API.

## План

- [x] Убрать нестабильные/stale факты из live docs и добавить regression-guard
      на удалённые lifecycle patterns в current-facing документации.
- [x] Выпустить docs-only `stitchkit@0.49.2` через exact-SHA CI artifact.
- [x] Обновить starter catalog/lock на опубликованный `^0.49.2`, закрыть
      changelog `create-stitchkit@0.3.1` и пройти target/HEAD lanes.
- [ ] Выпустить `create-stitchkit@0.3.1` и проверить npm/GitHub Release.

## Acceptance

- [x] Live docs не содержат split-ownership lifecycle snippets
      `rawRoutes: [socket.route]`, `server.stop()` или parallel
      `socket.io.close()` вне явно исторического upgrading before-block.
- [x] Generated `llms.txt`/`llms-full.txt` происходят из актуальных guide/API
      sources и не содержат hardcoded числа tests.
- [ ] Exact-SHA CI обоих release commits зелёный; npm versions, tag SHA и
      GitHub Releases совпадают с проверенными commits.
- [x] Packed target и HEAD starter variants проходят DB, HTTP, OpenAPI,
      Socket.IO, MCP, CLI и browser lanes на последнем Stitchkit patch.
- [x] В release не добавлены deprecated aliases, legacy lifecycle wrappers или
      consumer workaround.
