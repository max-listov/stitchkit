---
title: "Everything the public API forces on a consumer is reachable from outside"
description: "Четыре места, где публичная поверхность требует того, чего не отдаёт: коды вне реестра, неэкспортированный класс ошибки, нереализуемый интерфейс и опция, которая молча игнорируется."
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 13:31 +0000
related:
  - docs/decisions/0026-stitch-error-code-registry.md
---

# Everything the public API forces on a consumer is reachable from outside

## Зачем

Четыре независимых места, где потребитель не может сделать то, что от него
требует публичный API. Каждое мелкое, вместе — систематическая дыра в проверке
поверхности: `reference-coverage.test.ts` сверяет **имена** экспортов, но не
проверяет, что экспортированным можно воспользоваться.

**1. Два кода фреймворка вне реестра.** `application/kernel.ts:70` объявляет
`APPLICATION_NOT_ACCEPTING`, `application/grammy.ts:119` —
`GRAMMY_WEBHOOK_NOT_ACCEPTING`. Реестр `contract/errors.ts:118-136` объявлен
единственным источником правды для кодов, которые эмитит сам фреймворк
(→ ADR 0026), и не содержит ни одного из них. Следствия: `isStitchErrorCode()`
для них ложен; резолвер `createErrorHook({ unmappedCode })`, добавленный в
0.57.0, их типово не видит; `skills/stitchkit/SKILL.md` прямо инструктирует
потребителя ключеваться от `StitchErrorCode` и не копировать строки руками — а
для единственного публичного кода ядра приложения это не работает.

**2. Класс ошибки, который нельзя поймать по типу.**
`AgentRuntimeConflictError` (`agent-runtime/terminal-commit.ts:11`) летит из
`submit().result`, `recover()`, `resume()` и терминального коммита, но не
экспортирован ни из бареля `agent-runtime`, ни из `testing`, ни из
`docs/api/reference.md`. Потребителю остаётся сравнивать `error.name` со
строкой — ровно то, что документация запрещает.

**3. Интерфейс, который невозможно реализовать.**
`application/activity.ts:55` объявляет `const ActivityTokenBrand: unique symbol`
**без `export`**, а публичный `ActivityToken` (`:56-58`) содержит это поле.
`ActivityProjection` экспортируется из бареля и требует `open(): ActivityToken`.
Вне модуля токен сконструировать нечем — ни тестовым double, ни декоратором.

**4. Опция, которая типизируется, парсится и игнорируется.**
`kernel.ts:66` — `shutdown(options?: ShutdownOptions)`, тип импортирован из
`../server/shutdown` и **не реэкспортирован** из бареля `application`, так что
потребитель тянет его из `stitchkit/server`. Вместе с типом приезжает
`retryAfterSeconds` — HTTP-поле, которое в `kernel.ts` не читается ни разу.
`application.shutdown({ retryAfterSeconds: 30 })` компилируется, проходит
валидацию и не делает ничего; реально работает только одноимённая опция
`ManagedServerResourceConfig` (`server-resource.ts:9`).

## Результат

- Коды фреймворка объявлены в реестре и видны `isStitchErrorCode` и резолверу
  неотображённых кодов.
- Класс ошибки, летящий из публичных путей, экспортирован и пригоден для
  `instanceof`.
- Каждый публичный интерфейс реализуем вне модуля, где объявлен.
- Публичная сигнатура не принимает опций, которых не читает; тип, названный в
  публичной сигнатуре, доступен из того же entrypoint.
- Проверка поверхности умеет ловить этот класс дефектов, а не только
  отсутствие имени.

## План

- [x] Внести оба кода в `STITCH_ERROR_STATUS` с корректными статусами;
      проверить, что `createErrorHook`/`unmappedCode` их видят.
- [x] Экспортировать `AgentRuntimeConflictError` из бареля `agent-runtime` и
      внести в `docs/api/reference.md`.
- [x] Сделать `ActivityToken` конструируемым снаружи или убрать бренд, если он
      не несёт гарантии; решение обосновать.
- [x] Убрать `retryAfterSeconds` из опций `application.shutdown` (сузить тип) и
      реэкспортировать нужный тип опций из бареля `application`.
- [x] Расширить проверку поверхности: каждый тип, названный в публичной
      сигнатуре entrypoint, доступен из того же entrypoint; каждый класс
      ошибки, бросаемый публичным путём, экспортирован.
- [x] Внести записи в `CHANGELOG.md`; сужение опций — breaking, раздел в
      `upgrading.md` обязателен.

## Acceptance

- [x] `isStitchErrorCode('APPLICATION_NOT_ACCEPTING')` истинен, и код есть в
      реестре вместе со статусом.
- [x] Тест ловит `AgentRuntimeConflictError` через `instanceof`, импортировав
      его из публичного entrypoint.
- [x] Тест реализует `ActivityProjection` вне модуля `activity.ts` и
      компилируется.
- [x] `application.shutdown` не принимает `retryAfterSeconds`; тип опций
      доступен из `stitchkit/application`.
- [x] Проверка поверхности падает, если публичная сигнатура называет тип,
      недоступный из того же entrypoint.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `STITCH_ERROR_STATUS` получил `APPLICATION_NOT_ACCEPTING: 503`;
      `isStitchErrorCode` и резолвер `unmappedCode` теперь его видят.
- [x] `AgentRuntimeConflictError` экспортирован из бареля
      `stitchkit/agent-runtime` — ловится через `instanceof`, а не сравнением
      `error.name` со строкой.
- [x] `ActivityTokenBrand` экспортирован, поэтому `ActivityProjection`
      реализуем вне модуля, где объявлен.
- [x] `ApplicationShutdownOptionsSchema` собран через `.pick()` из канонической
      схемы: kernel принимает ровно те три поля, которые читает, и больше не
      типизирует HTTP-only `retryAfterSeconds`, который молча игнорировал.
- [x] Регрессия: packages/core/tests/application-kernel.test.ts::the public surface can be used from outside the module that declares it
- [x] Сужение типа держится компилятором: в том же тесте стоит `@ts-expect-error`
      на `retryAfterSeconds`, поэтому возврат опции сломает typecheck.
- [x] Строгая карта в packages/core/tests/error-hook.test.ts поймала новый код
      сама — ровно тот opt-in, ради которого `codeMap` делали частичной в
      0.56.1; это и есть доказательство, что механизм работает.
- [x] `docs/api/reference.md`, снапшот публичной поверхности, `CHANGELOG.md` и
      раздел `## Unreleased migration: a reachable public surface` обновлены.

## Что не сделано

- [x] `GRAMMY_WEBHOOK_NOT_ACCEPTING` намеренно **не** внесён в реестр: он
      принадлежит изолированному адаптеру провайдера, а `STITCH_ERROR_STATUS` —
      generic-ядру (→ ADR 0002). Имя провайдера не должно попадать в union,
      который импортирует каждый потребитель. Код проходит насквозь через
      частичную `codeMap`, и причина записана комментарием в `grammy.ts`.
