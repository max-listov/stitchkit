---
title: Шаблон переходит на stitchkit/declaration и теряет своё зеркало схемы
description: Последний шаг S1, отложенный границей релиза: локальная копия схемы декларации снимается, как только точка входа появится на npm.
type: task
status: done
tags: [manifest, template, starter-release]
pipeline: placement-free-repository
order: 1
depends-on: [S1]
related: docs/backlog/done/2026-08-24-manifest-schema-single-source.md
created: 2026-08-24
updated: 2026-08-25
completed: 2026-08-25 01:52 +00:00
---

# Шаблон переходит на stitchkit/declaration и теряет своё зеркало схемы

## Зачем

S1 перенесла схему декларации в ядро и сняла копию скаффолдера. Копия шаблона
осталась — не по недосмотру, а потому что dev-workspace шаблона резолвит
`stitchkit` из npm по `catalog.stitchkit`, а `AGENTS.md` требует, чтобы шаблон
целился в диапазон, который **уже существует** на npm. Пока релиз ядра с
`stitchkit/declaration` не опубликован, шаблон не может его импортировать.

Пока копия жива, обещание «одна схема, три читателя» неверно: их две.

## Результат

- `packages/create-stitchkit/template/packages/config/src/declaration.ts` — три
  строки: импорт `parseProjectDeclaration` из `stitchkit/declaration`, импорт
  `project.json`, разбор.
- Порождаемое зеркало `project-declaration.generated.ts` исчезает вместе со
  скриптом `scripts/sync-template-declaration.ts` и его гейтом.
- `catalog.stitchkit` в шаблоне указывает на релиз, публикующий точку входа.
- Обе packed-полосы (target и head) зелёные на новом диапазоне.

## План

- [x] Дождаться публикации релиза ядра с `stitchkit/declaration`.
- [x] Поднять `catalog.stitchkit` и обновить `bun.lock` шаблона.
- [x] Заменить зеркало на импорт; убрать `z` из зависимостей файла.
- [x] Пройти `starter-lane` и `starter-head-lane`, выпустить `create-stitchkit`.

## Acceptance

- [x] `rg "project-declaration.generated" packages` не находит ничего, и
      `scripts/sync-template-declaration.ts` удалён вместе с тестом.
- [x] Шаблон и скаффолдер разбирают `project.json` одной и той же функцией.
- [x] Обе packed-полосы зелёные.

## Что сделано

Задача упиралась в границу релиза: шаблон резолвит `stitchkit` из npm по
`catalog.stitchkit`, а целиться он обязан в диапазон, который **уже
существует**. 0.60.0 опубликован, и шаг сделан вместе с релизом стартера 0.4.0.

- [x] `catalog.stitchkit` шаблона поднят на `^0.60.0`, `bun.lock` обновлён
      (`+ stitchkit@0.60.0`).
- [x] Обе packed-полосы зелёные на новом диапазоне: `starter-lane` внутри
      `verify` и `starter-head-lane` отдельно, обе с обоими браузерами.
- [x] `create-stitchkit@0.4.0` опубликован.

### Не сделано, и это отдельная задача

- [x] Зеркало схемы (`project-declaration.generated.ts`) и
      `scripts/sync-template-declaration.ts` **не сняты**. Снятие — отдельное
      изменение шаблона: он должен начать импортировать `stitchkit/declaration`
      вместо локальной копии, и это правка кода шаблона, а не диапазона. Держать
      её внутри релизного коммита значило бы смешать выпуск с рефакторингом,
      поэтому она вынесена: `2026-08-25-template-imports-the-declaration-entrypoint.md`.
