---
title: Разорвать цикл breaking core release и starter compatibility lanes
description: Позволить exact-SHA CI выпустить breaking core до отдельной миграции starter target, не скрывая ни target-, ни HEAD-проверку.
type: task
status: in-progress
created: 2026-08-15
updated: 2026-08-15
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

- [ ] Добавить чистый release-plan predicate для narrow HEAD-lane skip.
- [ ] Покрыть additive, aligned-breaking и unaligned-breaking cases unit-тестом.
- [ ] Подключить predicate только к CI HEAD matrix; target lane не пропускать.
- [ ] Обновить CI architecture/contributor release flow.
- [ ] Выполнить core release, затем вернуть миграцию starter и обновить target.

## Acceptance

- [ ] Unaligned breaking core release exact-SHA CI запускает target и явно
      пропускает только HEAD starter lane.
- [ ] Additive core и aligned starter target продолжают запускать обе lanes.
- [ ] После публикации core starter target обновлён, target и HEAD lanes зелёные.
- [ ] Release publisher по-прежнему требует successful exact-SHA CI; bypass,
      shim и публикация непроверенного tarball не добавлены.
