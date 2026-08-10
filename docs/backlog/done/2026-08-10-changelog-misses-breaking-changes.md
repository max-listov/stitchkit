---
title: "The changelog misses this batch's breaking changes"
description: "Секции ⚠️ Breaking changes нет, хотя добавлен код в исчерпывающий Record, ужесточён CLI и сменён дефолт логгера."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:20 +07:00
---

# The changelog misses this batch's breaking changes

## Зачем

`CHANGELOG.md` в разделе `[Unreleased]` содержит только `### Added` и `### Fixed`.
Согласно собственной шапке файла и `AGENTS.md`, версия без секции
`### ⚠️ Breaking changes` объявляется потребителю **чисто аддитивной и безопасной к
принятию без правок кода**. Это неверно как минимум трижды.

**1. Добавлен код в исчерпывающий публичный `Record`.**
`REALTIME_CONTRACT_VIOLATION` внесён в `STITCH_ERROR_STATUS`, а
`ErrorHookConfig.codeMap` объявлен как `Record<StitchErrorCode, TWireCode>`.
Документированный паттерн `satisfies Record<StitchErrorCode, …>` перестаёт
компилироваться у каждого потребителя, следующего документации — включая два примера
в самом репозитории: `packages/core/src/server/error-hook.ts:19-24` и
`docs/guide/auth-and-errors.md:355-363`.

**2. CLI стал строже на конструировании.** Поле контракта или тул с зарезервированным
именем (`json`, `wait`, `quiet`, `help`, `version`, `output-dir`, `wait-timeout`)
теперь **бросает при построении CLI**, а неизвестные флаги завершаются ненулевым
кодом. Приложение, у которого сегодня есть поле `quiet`, упадёт на старте после
«чисто исправляющего» апгрейда.

**3. Сменён дефолт публичной фабрики.** `createToolLogger` пишет в `console.error`
вместо `console.info`. Изменение правильное (stdout — канал протокола stdio-MCP), но
это смена наблюдаемого поведения по умолчанию.

## Результат

- Раздел релиза содержит `### ⚠️ Breaking changes` с before → after по каждому из
  трёх пунктов.
- Документированные примеры, перестающие компилироваться, обновлены в том же заходе.
- Утверждение шапки changelog снова истинно.

## План

- [x] Секция `### ⚠️ Breaking changes` внесена в `[Unreleased]` с before → after
      по СЕМИ пунктам: `STITCH_ERROR_STATUS` + новый код,
      `RealtimeRejectedEvent.error` → `AppError`, строгий CLI (reserved-имена,
      unknown/дубли/конфликты флагов), дефолт `createToolLogger` → stderr,
      origin-less `cors` → ошибка конструирования, member-правило JSON-коэрции
      юнионов, граничное сопоставление ключей аудита.
- [x] `server/error-hook.ts` (docstring-пример) и
      `docs/guide/auth-and-errors.md` обновлены строкой
      `REALTIME_CONTRACT_VIOLATION: 'internal'` (выполнено в realtime-задаче
      этого захода).
- [x] Заход пересмотрен целиком: в секцию добавлены изменения дефолтов, которых
      в исходных трёх пунктах не было (cors, коэрция, маскирование аудита);
      ограничение времени model-controlled fetch отражено в `### Fixed`
      (новые опции с безопасными дефолтами).
- [x] Версионирование решено и записано строкой над секцией: следующий релиз —
      бамп минорной версии (0.45 → 0.46); сам бамп `packages/core/package.json`
      — часть релизного коммита владельца по протоколу.

## Acceptance

- [x] Секция существует, каждый пункт несёт рабочий before → after.
- [x] Оба документированных примера компилируются (`error-hook.test.ts` несёт
      тот же map; tsc ядра чистый).
- [x] Гейты прогнаны в рамках закрытия захода (полный verify — финальным шагом
      зонтичной задачи).

## Что сделано

- [x] Реализация: CHANGELOG.md (секция ⚠️ Breaking changes в [Unreleased]), packages/core/src/server/error-hook.ts, docs/guide/auth-and-errors.md.
- [x] Регрессия: scripts/release-plan.test.ts::release notes must be SUBSTANTIVE — a lone heading, comment or dot does not pass.
