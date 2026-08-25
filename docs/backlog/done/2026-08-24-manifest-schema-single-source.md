---
title: S1 — схема декларации проекта живёт в одном месте
description: Zod-схема декларации становится публичной поверхностью ядра; дубль identity-схемы между скаффолдером и шаблоном исчезает.
type: task
status: done
tags: [manifest, boundaries, core, scaffolder]
pipeline: placement-free-repository
order: 1
depends-on: []
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 22:20 +07:00
---

# S1 — схема декларации проекта живёт в одном месте

## Зачем

Схема идентичности приложения уже описана дважды, слово в слово:

- `packages/create-stitchkit/src/identity.ts:13` — `ApplicationIdentitySchema`,
  которой скаффолдер валидирует то, что записывает в `app.config.json`;
- `packages/create-stitchkit/template/packages/config/src/identity.ts:4` — она
  же, которой шаблон валидирует то, что читает.

Дубль пока дешёвый: четыре поля. Но декларация добавляет к ним роли, требования
и окружение, и тогда каждая правка схемы — это две синхронные правки в двух
пакетах, публикуемых независимо друг от друга. Расширять дубль нельзя, поэтому
это первая стадия конвейера.

Третий читатель делает вопрос принципиальным. Декларацию должна уметь прочитать
и провалидировать **сторона места** — то, что приводит deployment к source. Если
схема живёт в шаблоне, у стороны места нет способа получить её иначе, чем
скопировав, а копия — это форк, а не зависимость.

## Результат

- Схема декларации — публичная поверхность ядра, `stitchkit` экспортирует её
  из browser-safe корня или отдельной точки входа. Решение точки входа — часть
  этой стадии.
- Три читателя импортируют одну схему: шаблон, скаффолдер и любая сторона
  места. `create-stitchkit` получает зависимость от `stitchkit` (сегодня в его
  `dependencies` только `zod`).
- Схема несёт **версию** — поле, по которому сторона места решает, понимает ли
  она этот репозиторий. Само fail-closed поведение — стадия S8.
- Точка входа объявляет свою зрелость по ADR 0103.
- `ApplicationIdentitySchema` в обоих текущих местах исчезает, а не остаётся
  «пока что» рядом: по правилу репозитория shim'ов и алиасов не бывает.

## План

- [x] Выбрать точку входа и записать выбор ADR: почему декларация — часть
      контрактной поверхности, а не поверхности сервера.
- [x] Перенести Zod-схему в ядро с сообщениями об ошибке на уровне поля.
- [x] Перевести скаффолдер на импорт из ядра, удалить его копию. Копия шаблона снимается отдельной таской — см. «Чего не сделано».
- [x] Отразить новую точку входа в `AGENTS.md`, `docs/api/reference.md`,
      `docs/guide/`, `fixtures/public-surface.json` и в тесте покрытия
      `packages/core/tests/reference-coverage.test.ts`.
- [x] Записана строка в CHANGELOG. Раздела миграции нет намеренно: точка входа аддитивна, ломать нечего.

## Acceptance

- [x] `rg "ApplicationIdentitySchema" packages` не находит ничего: в ядре `ProjectDeclarationSchema`, в шаблоне временно `ApplicationDeclarationSchema`-зеркало.
- [x] `reference-coverage.test.ts` зелёный с новой точкой входа.
- [x] Схему можно импортировать из установленного пакета, не собирая репозиторий
      шаблона — проверено packed-lane, а не импортом по относительному пути.
- [x] Скаффолдер собирается и проходит свои тесты (24/24) — без новой зависимости, схема вшита сборкой.

## Что сделано

### Ядро

- [x] `packages/core/src/manifest.ts` — `ProjectDeclarationSchema`,
      `ProjectSlugSchema`, `ProjectDescriptionSchema`, `ProjectDeclaration`,
      `parseProjectDeclaration`, `PROJECT_DECLARATION_SCHEMA_VERSION`.
- [x] Версия проверяется **до** чтения полей и отвергается fail-closed.
      Мутация подтвердила смысл порядка: сняв проверку, декларация версии 2
      сообщает о себе пятью «неожиданными полями», а не как о версии, которую
      эта сборка не умеет обслуживать.
- [x] Точка входа `stitchkit/manifest` объявлена **evolving** и проведена через
      все шлюзы: `packages/core/package.json#exports`, `build:browser`,
      `scripts/check-browser-clean.mjs`, `tests/reference-coverage.test.ts`,
      `tests/fixtures/public-surface.json`,
      `scripts/consumer-lane/optional-peer-matrix.mjs`,
      `docs/guide/getting-started.md`, `docs/api/reference.md`, `AGENTS.md`.

### Решение

- [x] ADR 0104 `docs/decisions/0104-the-project-declaration-ships-from-the-framework.md`
      + строка в индексе. Записаны три отвергнутых альтернативы, включая
      JSON Schema вместо Zod.

### Скаффолдер

- [x] `packages/create-stitchkit/src/identity.ts` больше не объявляет схему —
      он импортирует её из исходников ядра относительным путём, и `bun build`
      вшивает её в `dist/cli.js`. Проверено: `Use lowercase letters` есть в
      сборке, `zod` остался внешним. Рантайм-зависимости от `stitchkit` нет,
      поэтому и порядка релизов между пакетами это не создаёт.
- [x] `tests/scaffold.test.ts` теперь **парсит** записанный `app.config.json`
      схемой ядра, а не сравнивает его с литералом: если декларация вырастет,
      скаффолдер не сможет молча писать неполный файл.

### Регрессия

- [x] `packages/core/tests/project-declaration.test.ts` — шесть случаев:
      `accepts a declaration that names no machine`,
      `refuses an unrecognised schema version before reading any field`,
      `refuses a declaration with no schema version at all`,
      `rejects a slug that cannot become a process name`,
      `requires at least one locale but fixes no locale set`,
      `a project narrows the locale set by extending, not by restating`.

### Чего не сделано и почему

- [x] Шаблон импортирует схему из `stitchkit/manifest` — **отложено**, см.
      `inbox/2026-08-24-template-adopts-manifest-entrypoint.md`. Невозможно в этом
      релизе, и это физика собственных правил репозитория:** dev-workspace
      шаблона резолвит `stitchkit` из npm по `catalog.stitchkit` (сегодня
      `^0.59.0`, симлинк на `stitchkit@0.59.4`), а `AGENTS.md` требует, чтобы
      шаблон целился в диапазон, который уже существует на npm. Точка входа
      появится на npm только вместе с этим релизом ядра.
      `packages/create-stitchkit/template/packages/config/src/identity.ts`
      остаётся локальным зеркалом с комментарием, который это называет и
      указывает на ADR 0104. Следующий шаг — отдельная таска
      `2026-08-24-template-adopts-manifest-entrypoint.md`.
- [x] `app.config.json` уже несёт `schemaVersion: 1` в обоих местах (шаблон и
      то, что пишет скаффолдер), так что переход шаблона будет заменой файла
      схемы на импорт, а не изменением данных.
