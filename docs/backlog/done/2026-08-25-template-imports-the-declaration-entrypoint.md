---
title: Шаблон импортирует stitchkit/declaration и теряет зеркало схемы
description: Диапазон уже указывает на релиз с точкой входа; осталось заменить порождаемую копию схемы импортом и снять генератор вместе с его гейтом.
type: task
status: done
tags: [declaration, template]
related: docs/backlog/done/2026-08-24-template-adopts-manifest-entrypoint.md
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 02:52 +00:00
---

# Шаблон импортирует stitchkit/declaration и теряет зеркало схемы

## Зачем

Шаблон уже целится в `^0.60.0` — релиз, публикующий `stitchkit/declaration`.
Пока копия схемы жива, обещание «одна схема, три читателя» неверно: их две.
Копия порождается и сверяется гейтом, поэтому разойтись молча не может, но она
всё ещё второй файл, который надо держать в согласии.

Отделено от релиза намеренно: замена копии импортом — правка кода шаблона, а не
диапазона, и внутри релизного коммита она смешала бы выпуск с рефакторингом.

## Результат

- `packages/create-stitchkit/template/packages/config/src/declaration.ts` — три
  строки: импорт `parseProjectDeclaration` из `stitchkit/declaration`, импорт
  `project.json`, разбор.
- `project-declaration.generated.ts` исчезает вместе со
  `scripts/sync-template-declaration.ts`, его тестом и шагом в `build`.
- Импорт типа `ProjectDeclaration` в шаблонных скриптах идёт из точки входа.

## План

- [x] Заменить зеркало импортом; убрать `z` из зависимостей файла.
- [x] Снять генератор, его тест и шаг `gen:template-declaration`.
- [x] Обе packed-полосы зелёные.

## Acceptance

- [x] `rg "project-declaration.generated" packages` не находит ничего.
- [x] Шаблон и скаффолдер разбирают `project.json` одной функцией.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Шаблон:
      `packages/create-stitchkit/template/packages/config/src/declaration.ts`
      импортирует `parseProjectDeclaration` и `findProjectRole` из
      `stitchkit/declaration`; `scripts/declaration.ts`, `build-inputs.ts`,
      `build-inputs.test.ts` и `release-steps.ts` берут типы оттуда же.
- [x] Шаблон: `packages/config/package.json` объявляет `stitchkit: catalog:`;
      `bun.lock` обновлён одной строкой.
- [x] Удалены `packages/config/src/project-declaration.generated.ts` (611
      строк), `scripts/sync-template-declaration.ts` и его тест; шаг
      `gen:template-declaration` снят из `build`, а устаревшее упоминание
      зеркала — из `scripts/sync-example-declarations.ts`.
- [x] Каналы миграции: `packages/create-stitchkit/CHANGELOG.md`
      (`### Changed` под `[Unreleased]`) и
      `packages/create-stitchkit/UPGRADING.md`
      (`## Unreleased migration: the declaration schema is imported`) — правка
      меняет уже сгенерированный проект, и он должен узнать об этом не из
      чата.

### Найдено по дороге: окно до `bun install`

Правка сломала `packages/create-stitchkit/tests/scaffold.test.ts::creates a
project-specific local environment from the neutral example`, и это оказался не
шум теста, а настоящее свойство продукта. Сценарий `--no-install` рендерит
`.env` **до** установки зависимостей; работало это до сих пор потому, что
зеркало тянуло только `zod`, а `zod` Bun доставал автоустановкой. `stitchkit`
объявлен как `catalog:`, автоустановка каталог не разрешает — и скрипт упал.

Правильный ответ оказался не «ослабить тест», а «взять то, что нужно»:
`scripts/local-env.ts` нужен один slug, и он читает его из
`app-identity.generated.ts` — модуля без зависимостей, который скаффолдер и так
переписывает под личность назначения. В тест дописано, что он проверяет и это
свойство тоже, иначе следующий импорт вернёт ту же поломку молча.

### Проверка

- [x] `bun run verify` — **EXIT=0**: lint, check, 1687 тестов ядра, 25
      скаффолдера, 39 скриптов шаблона, Postgres-полоса agent-store, build, оба
      smoke, consumer-полоса и **обе** packed-полосы стартера (blank и
      repository, по 42 e2e в трёх браузерах) с `stitchkit 0.60.0` из npm.
- [x] `bun run supervised-lane` — зелёная: обе роли под настоящим PM2 поднялись,
      ответили и остановились `Shutdown clean` с кодом 0. Это единственная
      полоса CI, которой нет в `verify`; на этой машине `pm2` есть, и разрыв
      закрыт локально, а не оставлен на релизный прогон.
- [x] Типы шаблона резолвятся из опубликованного `stitchkit@0.60.0` — то есть
      проверена сама точка входа, а не её копия в дереве.

### Чего не сделано

- [x] Релиз `create-stitchkit` с этой правкой не выпускался и в эту задачу не входит: выпуск — отдельная команда владельца. Правка лежит в `[Unreleased]` обоих каналов скаффолдера и уедет со следующим релизом.
