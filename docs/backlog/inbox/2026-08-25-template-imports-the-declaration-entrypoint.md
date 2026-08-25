---
title: Шаблон импортирует stitchkit/declaration и теряет зеркало схемы
description: Диапазон уже указывает на релиз с точкой входа; осталось заменить порождаемую копию схемы импортом и снять генератор вместе с его гейтом.
type: task
status: inbox
tags: [declaration, template]
related: docs/backlog/done/2026-08-24-template-adopts-manifest-entrypoint.md
created: 2026-08-25
updated: 2026-08-25
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

- [ ] Заменить зеркало импортом; убрать `z` из зависимостей файла.
- [ ] Снять генератор, его тест и шаг `gen:template-declaration`.
- [ ] Обе packed-полосы зелёные.

## Acceptance

- [ ] `rg "project-declaration.generated" packages` не находит ничего.
- [ ] Шаблон и скаффолдер разбирают `project.json` одной функцией.
- [ ] `bun run verify` зелёный.
