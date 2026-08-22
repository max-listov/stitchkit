---
title: "The skipped HEAD starter lane hides template drift until an additive release"
description: "Пропуск packed HEAD lane на breaking-релизах прячет несмигрированный шаблон: дрейф всплывает через несколько релизов и роняет чужой release run."
type: task
status: done
created: 2026-08-21
updated: 2026-08-22
completed: 2026-08-22 19:04 +0000
related:
  - docs/backlog/done/2026-08-21-release-calibre-and-cancellation-polish.md
---

# The skipped HEAD starter lane hides template drift until an additive release

## Зачем

`shouldRunStarterHeadLane` пропускает packed HEAD lane, когда release notes
содержат `### ⚠️ Breaking changes`, а minor ядра разошёлся с caret-целью
шаблона. Логика верна по своему назначению: опубликованный starter не может
потреблять ядро, которого ещё нет на npm.

Побочный эффект — накопление. Пока релизы подряд breaking, lane не выполняется
ни разу, и шаблон может тихо перестать компилироваться против HEAD. Проверка
возвращается только на первом не-breaking релизе, где падение выглядит как
дефект этого релиза, хотя корень возник несколькими версиями раньше.

Так и произошло: `0.56.0` расширил `StitchErrorCode` семью `FILE_*` и честно
описал миграцию для исчерпывающих карт, но шаблон в том же проходе не
мигрировали. Четыре breaking-релиза подряд lane пропускался. Красным стал
release run версии `0.56.1`, к содержимому которой причина отношения не имела.

## Результат

- Расхождение шаблона с HEAD обнаруживается в том релизе, который его создал,
  а не через несколько версий.
- Правило «обновить контролируемых потребителей в том же проходе» имеет
  механическую проверку, а не только формулировку в `AGENTS.md`.
- Существующая защита остаётся: packed HEAD lane по-прежнему не требует от
  опубликованного стартера потреблять ещё не выпущенное ядро.

## План

- [x] Заменить автоматический breaking skip на fail-closed decision: по
      умолчанию packed local-HEAD lane запускается.
- [x] Разрешать bridge skip только по exact-version review record с outcome
      `deferred` и непустой причиной.
- [x] Покрыть absent, stale, malformed, compatible и deferred decisions тестами.
- [x] Синхронизировать CI/pre-push diagnostics и architecture docs.
- [x] Пройти разрешённые project gates конвейера 0/0.

## Acceptance

- [x] Unaligned breaking release без review record запускает HEAD lane и ловит
      template drift на создавшем его SHA.
- [x] Exact-version `deferred` review сохраняет release bridge, явно называет
      долг и не заставляет published starter потреблять unpublished core.
- [x] Stale/empty/unknown review fail closed: lane запускается.
- [x] Additive и aligned releases сохраняют прежнее обязательное поведение.
- [x] CI и pre-push используют одно решение и одинаково объясняют редкий skip.

## Что сделано

- [x] **Decision:** `scripts/release-plan.ts` запускает HEAD fail-closed и
      признаёт skip только для exact core version + `deferred` + non-empty
      reason из `scripts/starter-head-review.json`.
- [x] **Regression:** `scripts/release-plan.test.ts`, case
      `an unaligned breaking release runs HEAD unless an exact deferred review exists`,
      фиксирует absent, exact, stale, empty, unknown, aligned и additive paths.
- [x] **CI:** `.github/workflows/ci.yml` и
      `scripts/workflow-permissions.test.ts`, case
      `the starter matrix contains every mode, variant and browser surface`,
      сохраняют общий decision command и видимый debt diagnostic.
- [x] **Architecture:** `docs/decisions/0099-starter-head-skips-require-versioned-review.md`,
      `docs/decisions/README.md`, `docs/architecture/ci-release.md` и
      `CONTRIBUTING.md` фиксируют review schema и lifecycle.
- [x] **Validation:** targeted 42 tests, core/scripts typechecks,
      `bun run verify` и обе packed local-HEAD variants через
      `bun run starter-head-lane` завершились с exit 0.
