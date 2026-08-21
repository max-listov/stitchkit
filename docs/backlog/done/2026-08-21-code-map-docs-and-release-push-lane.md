---
title: "The partial code map is documented and a release push proves the starter on HEAD"
description: "Закрыть хвосты 0.56.1: гайд и JSDoc учили обратному тому, что делает код, а packed HEAD starter lane узнавался только из красного CI на релизном коммите."
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21 05:58 +0000
related:
  - docs/backlog/done/2026-08-21-release-calibre-and-cancellation-polish.md
  - docs/backlog/inbox/2026-08-21-starter-head-lane-blind-spot.md
  - docs/backlog/inbox/2026-08-21-declarative-unmapped-code-fallback.md
---

# The partial code map is documented and a release push proves the starter on HEAD

## Зачем

Релиз 0.56.1 сделал `ErrorHookConfig.codeMap` частичным, но оставил два хвоста.

**Документация разошлась с кодом.** `docs/guide/auth-and-errors.md` продолжал
требовать «the exhaustive `codeMap`» и обещал, что `satisfies Record<
StitchErrorCode, …>` «keeps the map exhaustive across upgrades» — тогда как
именно эта конструкция и ломается на апгрейде. JSDoc в
`packages/core/src/server/error-hook.ts` утверждал то же самое. Хуже, оба
примера были неполными: скопировавший их вместе с `satisfies` получал ошибку
компиляции против 0.56.x, потому что семь `FILE_*` в них не попали. Опубликованный
список кодов в гайде тоже остался предшествующим 0.56.0.

**Красный CI на релизном коммите.** Packed HEAD starter lane не входит в
локальный `verify` — тот гоняет только target. Поэтому расхождение шаблона с
HEAD, накопленное с 0.56.0, обнаружилось только прогоном CI на релизном
коммите 0.56.1, то есть на том единственном коммите, чей прогон обязан быть
зелёным до тега. Проверка существовала, но запускалась слишком поздно.

## Результат

- Гайд и JSDoc описывают частичную карту, называют цену и показывают `satisfies`
  как осознанный opt-in, а не как рекомендацию по умолчанию.
- Ни один пример в документации не ломается при копировании: исчерпывающий
  пример действительно исчерпывающий, остальные — намеренно частичные.
- Список публикуемых stitch-кодов соответствует `STITCH_ERROR_STATUS` и
  сообщает, что набор растёт в обычных релизах.
- Релизный push прогоняет packed HEAD starter lane локально — по той же
  политике, что и CI, поэтому breaking-релиз он не блокирует.
- Пропуск лейна перестал быть немым: он печатает, что именно осталось
  непроверенным и когда долг будет закрыт.

## План

- [x] Переписать раздел `createErrorHook` в гайде и JSDoc фабрики.
- [x] Привести примеры карт в компилируемое состояние.
- [x] Актуализировать список stitch-кодов.
- [x] Добавить `branchHeads` в `PrePushPlan` и `isReleaseCommitSubject`.
- [x] Вынести решение по HEAD-лейну в общий helper и вызвать его из `pre-push`.
- [x] Покрыть новое поведение тестами и прогнать полный `bun run verify`.

## Acceptance

- [x] В `docs/` и `packages/core/src/` не осталось утверждений, что `codeMap`
      обязана быть исчерпывающей.
- [x] Исчерпывающий пример в гайде содержит все семнадцать кодов
      `STITCH_ERROR_STATUS`.
- [x] `classifyPrePush` возвращает уникальные tips пушнутых веток и не считает
      удаление ветки за tip.
- [x] `isReleaseCommitSubject` принимает `release(core|starter):` и отвергает
      устаревшую форму `release: X.Y.Z` и упоминание в теле.
- [x] `starter-head` продолжает отвечать `run`/`skip` после выноса helper'а.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `docs/guide/auth-and-errors.md`: раздел `createErrorHook` переписан —
      частичная карта по умолчанию, `satisfies` вынесен в отдельный сниппет как
      opt-in с названной ценой; пример карты сделан частичным; исчерпывающий
      пример `STITCH_TO_APP` дополнен `REALTIME_CONTRACT_VIOLATION` и семью
      `FILE_*`; список кодов приведён к `STITCH_ERROR_STATUS`.
- [x] `packages/core/src/server/error-hook.ts`: JSDoc описывает частичную карту
      и opt-in, пример больше не заявляет исчерпывающность неполным списком.
- [x] `scripts/release-plan.ts`: `PrePushPlan.branchHeads`,
      `isReleaseCommitSubject`, helper `starterHeadDecision` (общий с командой
      `starter-head`), `hasReleaseCommit`; `pre-push` после `verify` прогоняет
      `starter-head-lane` для релизного коммита, а при отказе политики печатает
      причину и оставшийся долг.
- [x] `scripts/release-plan.test.ts` cases `a pushed branch tip is reported so a
      release push can prove the starter on HEAD` и `only a release commit
      subject opens the extra release-push gate`; существующие проверки формы
      плана дополнены `branchHeads`.
- [x] `docs/backlog/inbox/2026-08-21-declarative-unmapped-code-fallback.md` —
      декларативный fallback для неотображённых кодов оформлен как идея, а не
      добавлен вслед за релизом.

## Не входит

- Политика пропуска HEAD-лейна на breaking-релизах: остаётся отдельной задачей
  в inbox, потому что меняет правило CI, а не место его применения.
- Новое публичное API для fallback: оформлено идеей.
