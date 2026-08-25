---
title: Шаблон переходит на stitchkit/declaration и теряет своё зеркало схемы
description: Последний шаг S1, отложенный границей релиза: локальная копия схемы декларации снимается, как только точка входа появится на npm.
type: task
status: inbox
tags: [manifest, template, starter-release]
pipeline: placement-free-repository
order: 1
depends-on: [S1]
related: docs/backlog/done/2026-08-24-manifest-schema-single-source.md
created: 2026-08-24
updated: 2026-08-24
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

- [ ] Дождаться публикации релиза ядра с `stitchkit/declaration`.
- [ ] Поднять `catalog.stitchkit` и обновить `bun.lock` шаблона.
- [ ] Заменить зеркало на импорт; убрать `z` из зависимостей файла.
- [ ] Пройти `starter-lane` и `starter-head-lane`, выпустить `create-stitchkit`.

## Acceptance

- [ ] `rg "project-declaration.generated" packages` не находит ничего, и
      `scripts/sync-template-declaration.ts` удалён вместе с тестом.
- [ ] Шаблон и скаффолдер разбирают `project.json` одной и той же функцией.
- [ ] Обе packed-полосы зелёные.
