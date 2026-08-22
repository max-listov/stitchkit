---
title: "A code map has no declarative fallback for unmapped codes"
description: "После перехода codeMap на Partial неотображённый код уезжает в написании фреймворка; выбор catch-all выразим только вручную в render."
type: task
status: done
created: 2026-08-21
updated: 2026-08-22
completed: 2026-08-22 19:04 +0000
related:
  - docs/guide/auth-and-errors.md
---

# A code map has no declarative fallback for unmapped codes

## Зачем

`ErrorHookConfig.codeMap` стал частичным, и это сняло вынужденную миграцию у
каждого потребителя при добавлении кода. Взамен появился третий вариант
поведения, которого раньше не существовало: код, который проект не отобразил,
уезжает на провод в написании фреймворка.

Сейчас у проекта два выхода. Либо `satisfies Record<StitchErrorCode, …>` —
тогда компилятор потребует решения при каждом добавлении кода. Либо разбор
`info.code` вручную внутри `render`. Третьего — «всё, что я не отобразил,
называется вот так» — декларативно выразить нечем, хотя это самый частый ответ
для проекта с фиксированным вокабуляром.

## Результат

- Проект может объявить одно значение для всех неотображённых stitch-кодов, не
  перечисляя их и не разбирая `info.code` в `render`.
- Умолчание не меняется: без объявления код по-прежнему едет как есть.
- Выбор виден в типе конфигурации, а не только в гайде.

## План

- [x] Добавить typed `unmappedCode`: фиксированное значение или функция от
      `StitchErrorCode` без изменения default passthrough.
- [x] Применять fallback только к framework-кодам; project-owned `AppError`
      codes сохранять без изменений.
- [x] Покрыть value/function/default/project-code cases regression-тестами.
- [x] Обновить guide, API reference и changelog.
- [x] Пройти разрешённые project gates конвейера 0/0.

## Acceptance

- [x] Частичная `codeMap` может свести все остальные framework-коды к одному
      wire-code без ручного разбора внутри `render`.
- [x] Функция fallback получает narrowed `StitchErrorCode` и может группировать
      коды; явно mapped code всегда имеет приоритет.
- [x] Без `unmappedCode` observable behavior не меняется.
- [x] Project-owned code никогда не проходит через framework fallback.
- [x] Public docs и release notes описывают точный контракт.

## Что сделано

- [x] **Core:** `packages/core/src/server/error-hook.ts` добавляет typed
      `unmappedCode` value/resolver после explicit map lookup и только внутри
      narrowed `StitchErrorCode` boundary.
- [x] **Regression:** `packages/core/tests/error-hook.test.ts`, cases
      `a declarative fallback maps only unmapped stitchkit codes`,
      `an unmapped-code resolver receives a narrowed framework code` и
      `a partial code map maps what it lists and passes the rest through as itself`.
- [x] **Public docs:** `docs/guide/auth-and-errors.md`,
      `docs/api/reference.md` и `CHANGELOG.md` описывают precedence,
      value/function forms, passthrough default и project-code exclusion.
- [x] **Validation:** targeted 42 tests, core/scripts typechecks,
      `bun run verify` и `bun run starter-head-lane` завершились с exit 0.
