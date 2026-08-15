---
title: Разорвать цикл breaking core release и starter compatibility lanes
description: Позволить exact-SHA CI выпустить breaking core до отдельной миграции starter target, не скрывая ни target-, ни HEAD-проверку.
type: task
status: done
created: 2026-08-15
updated: 2026-08-15
completed: 2026-08-15 01:12 +0000
related: docs/architecture/ci-release.md
---

# Разорвать цикл breaking core release и starter compatibility lanes

## Зачем

Breaking core release меняет API раньше, чем новая версия существует в npm.
Текущий starter одновременно проверяется против опубликованного catalog target
и packed core HEAD. При hard cut одна и та же template source не может
скомпилироваться с обеими несовместимыми версиями, а publisher требует зелёный
exact-SHA CI до публикации core. Получается циклическая release-зависимость.

## Результат

- Core release candidate сохраняет текущий опубликованный starter и target lane.
- HEAD lane пропускается только когда changelog текущей core-версии явно содержит
  breaking changes и starter target ещё относится к другому pre-1.0 minor.
- После публикации core отдельная starter-миграция обновляет target; обе lanes
  снова обязательны и проходят перед самостоятельным starter release.

## План

- [x] Добавить чистый release-plan predicate для narrow HEAD-lane skip.
- [x] Покрыть additive, aligned-breaking и unaligned-breaking cases unit-тестом.
- [x] Подключить predicate только к CI HEAD matrix; target lane не пропускать.
- [x] Обновить CI architecture/contributor release flow.
- [x] Выполнить core release, затем вернуть миграцию starter и обновить target.

## Acceptance

- [x] Unaligned breaking core release exact-SHA CI запускает target и явно
      пропускает только HEAD starter lane.
- [x] Additive core и aligned starter target продолжают запускать обе lanes.
- [x] После публикации core starter target обновлён, target и HEAD lanes зелёные.
- [x] Release publisher по-прежнему требует successful exact-SHA CI; bypass,
      shim и публикация непроверенного tarball не добавлены.

## Что сделано

- [x] **Release predicate:** `scripts/release-plan.ts` ограничивает HEAD skip
      только changelog-доказанным unaligned pre-1.0 hard cut; regressions находятся
      в `scripts/release-plan.test.ts`, test `skips HEAD only for an unaligned,
      changelog-proven breaking core minor`.
- [x] **CI:** `.github/workflows/ci.yml` применяет predicate только к HEAD cells,
      а `scripts/workflow-permissions.test.ts` сохраняет fail-closed exact-SHA
      publication graph.
- [x] **Starter migration:** canonical template использует полный `socket` handle,
      `server.shutdown()` и catalog `^0.49.0`; `bun run verify` доказал обе target
      variants, `bun run starter-head-lane` — обе packed-HEAD variants.
- [x] **Release:** `stitchkit@0.49.0` и GitHub Release `v0.49.0` опубликованы из
      exact-SHA CI artifact; bypass и compatibility shim не добавлялись.
