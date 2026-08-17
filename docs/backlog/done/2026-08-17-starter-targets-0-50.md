---
title: Стартер целится в Stitchkit 0.50 и показывает его примитивы
description: Поднять catalog шаблона до ^0.50.0 и заменить ручную связку сигналов на bindProcessSignals — стартер обязан показывать канонический путь, а не обходной.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 14:29 +00:00
related: docs/backlog/done/2026-08-17-process-signal-shutdown-binding.md
---

# Стартер целится в Stitchkit 0.50

## Зачем

`stitchkit@0.50.0` опубликован. Шаблон стартера всё ещё целится в `^0.49.2`, и
его `packages/backend/src/index.ts` содержит ту самую ручную машину сигналов,
ради устранения которой в 0.50 появился `bindProcessSignals`. Пока это так,
стартер учит обходному пути, а `starter-lane` проверяет прошлый релиз.

В проходе, где `bindProcessSignals` делался, тронуть стартер было нельзя:
`starter-lane` идёт `--mode=target` против **опубликованного** диапазона и
явно падает, если резолвится локально запакованное ядро. Теперь диапазон
существует на npm, и ограничение снято.

Ручная версия в шаблоне вдобавок неполна ровно там, где примитив полон: провал
`mcp.close()` / `prisma.$disconnect()` она рапортует как провал shutdown, третий
сигнал у неё не делает ничего, а два сигнала от супервизора в одном тике
схлопывают grace period.

## Результат

- `catalog.stitchkit` шаблона — `^0.50.0`, lockfile пересобран.
- Шаблонный backend использует `bindProcessSignals`; ручной `AbortController`,
  `shutdownPromise` и `process.on` удалены.
- Оба лейна зелёные: `starter-lane` (против опубликованного 0.50.0) и
  `starter-head-lane` (против локального HEAD).
- `create-stitchkit` выпущен своей версией со своим changelog.

## План

- [x] `catalog.stitchkit` в `packages/create-stitchkit/template/package.json` →
      `^0.50.0`; пересобрать `template/bun.lock`.
- [x] Заменить ручной shutdown в
      `packages/create-stitchkit/template/packages/backend/src/index.ts` на
      `bindProcessSignals`: `onComplete` закрывает MCP и Prisma и ставит
      `process.exitCode`, `onError(phase, …)` логирует с фазой.
- [x] Проверить `packages/create-stitchkit/examples/repository` — он объявляет
      доменные ошибки через `defineErrors` без `message`; решить, показывать ли
      объявленный текст (это ровно тот сценарий, ради которого поле вводилось).
- [x] `bun run starter-lane` и `bun run starter-head-lane` — оба зелёные.
- [x] Бампнуть **только** `packages/create-stitchkit/package.json`, прокатить
      `packages/create-stitchkit/CHANGELOG.md`.
- [x] `bun run verify`, коммит, тег `create-stitchkit-vX.Y.Z`.

## Acceptance

- [x] Шаблон резолвит `stitchkit@0.50.0` в своём lockfile.
- [x] В шаблонном backend нет `process.on('SIGINT'|'SIGTERM')` и нет ручного
      `AbortController` вокруг shutdown.
- [x] `starter-lane` и `starter-head-lane` зелёные.
- [x] Версия ядра `0.50.0` не тронута — релизные линии независимы.

## Что сделано

### Шаблон

- [x] `packages/create-stitchkit/template/package.json` — `catalog.stitchkit`
      поднят до `^0.50.0`; `template/bun.lock` пересобран, резолвит
      `stitchkit@0.50.0`.
- [x] `packages/create-stitchkit/template/packages/backend/src/index.ts` — ручной
      `AbortController` + `shutdownPromise` + два `process.on` заменены на
      `bindProcessSignals(server, …)`: MCP и Prisma закрываются в `onComplete`,
      там же ставится `process.exitCode`, ошибки логируются с фазой через
      `onError(phase, error)`.

### Пример

- [x] `examples/repository/.../domain/errors.ts` — `GITHUB_UNAVAILABLE` несёт
      `message` в определении; `.../repository/github-cache.ts` больше не
      повторяет текст на throw-site. Это ровно тот сценарий, ради которого поле
      вводилось, и теперь он показан в примере, а не только в гайде.

### Релиз скаффолдера

- [x] `packages/create-stitchkit/package.json` → `0.3.2`; версия ядра `0.50.0`
      не тронута — линии независимы.
- [x] `packages/create-stitchkit/CHANGELOG.md` прокатан, с явным перечислением
      того, чем ручная версия была хуже примитива.

### Гейты

- [x] `bun run starter-lane` — зелёный: оба варианта шаблона собраны против
      **опубликованного** `stitchkit@0.50.0 (^0.50.0)`.
- [x] `bun run starter-head-lane` — зелёный: оба варианта против локального HEAD.
- [x] `bun run verify` — зелёный.

### Поймано verify после зелёных лейнов

- [x] `bun install --lockfile-only` обновил `template/bun.lock`, но не
      `template/node_modules`, и `check:template` типизировался против ещё
      установленного 0.49.2: `Module 'stitchkit/server' has no exported member
      'bindProcessSignals'`. Лейны этого не видели — они ставят зависимости с
      нуля во временной директории. Вылечено обычным `bun install` в шаблоне.
