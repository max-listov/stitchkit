---
title: Штамп сборки попал в шаблон и уедет в каждый сгенерированный проект
description: bun run build в dev-workspace записал .build-stamp.json внутрь шаблона; скаффолдер его не исключает, а значит копирует — и первый же pm2:prod у потребителя откажет.
type: task
status: done
tags: [starter, release, safety]
related: docs/backlog/done/2026-08-25-a-release-cannot-start-a-stale-artifact.md
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 05:04 +00:00
---

# Штамп сборки попал в шаблон и уедет в каждый сгенерированный проект

## Зачем

`.build-stamp.json` — выход сборки **потребителя**, и существовать он должен
только там, где эта сборка прошла. Сейчас он лежит в
`packages/create-stitchkit/template/`, потому что я запустил `bun run build` в
dev-workspace шаблона, а фильтр копирования (`scaffold.ts:65`) исключает
`.env`, `next-env.d.ts`, `*.log` и `*.tsbuildinfo` — и не исключает его.

Следствие: каждый сгенерированный проект получит чужой штамп от чужого
источника. Первый же `bun run pm2:prod` до сборки откажет с сообщением о
несовпадении digest — то есть новый гейт будет ошибаться на нетронутом
скаффолде, ровно так же, как ошибался smoke до починки.

Это одновременно доказательство более общего: дерево после последних правок не
пересобиралось целиком.

## Результат

- Файл исключён фильтром копирования скаффолдера — по имени, рядом с `.env`.
- Файла нет в шаблоне и он не может туда вернуться незамеченным: гейт
  запрещает его присутствие в упакованном шаблоне.
- Корневой `.gitignore` репозитория покрывает путь шаблона.

## План

- [x] Убрать файл; добавить исключение в `isTemplateSourcePathIncluded`.
- [x] Тест: упакованный шаблон не содержит `.build-stamp.json`.
- [x] Проверить, нет ли других выходов сборки, попавших в шаблон тем же путём.

## Acceptance

- [x] Свежий скаффолд не содержит штампа до первой своей сборки.
- [x] `bun run verify` зелёный.

## Что сделано

### Scaffolder

- [x] `packages/create-stitchkit/template/.build-stamp.json` удалён.
- [x] `packages/create-stitchkit/src/scaffold.ts`:
      `isTemplateSourcePathIncluded` исключает `.build-stamp.json` по имени,
      рядом с `.env`.
- [x] Корневой `.gitignore` покрывает
      `packages/create-stitchkit/template/.build-stamp.json`.
- [x] `scripts/starter-lane.ts` запрещает `package/template/.build-stamp.json`
      в упакованном скаффолдере — там же, где `.env` и `dist/`. Этот гейт сразу
      же и сработал: фильтр копирования — не единственный потребитель правила.
- [x] **Корень**: `bun pm pack` читает поле `files` в
      `packages/create-stitchkit/package.json`, а не
      `isTemplateSourcePathIncluded`. Два списка, которые обязаны совпадать, —
      и один из них забыли. Исключения вынесены в данные
      (`IGNORED_DIRECTORIES`, `IGNORED_FILE_NAMES`, `IGNORED_FILE_SUFFIXES`), в
      манифест добавлены `!template/**/.build-stamp.json` и
      `!examples/**/.build-stamp.json`, а тест `what the copy excludes, the
      published package excludes too` держит списки вместе: добавление имени в
      фильтр падает, пока манифест его не несёт.

### Регрессия

- [x] `packages/create-stitchkit/tests/scaffold.test.ts`: `excludes runtime
      artifacts from scaffold and package inputs` и `what the copy excludes, the
      published package excludes too` (проверен на убийство: снятие одной
      негации в манифесте роняет тест).
- [x] Упакованный tarball проверен напрямую: `package/template/.build-stamp.json`
      в нём нет, а `scripts/build-stamp.ts` и его тест — есть.
- [x] Живой прогон: `bun run acceptance:local` в шаблоне до сборки отказал
      именно с «No build stamp beside the artifacts» — то есть отсутствие файла
      наблюдаемо, а не предположено.

### Прочие выходы сборки в шаблоне

- [x] Проверено: других непроигнорированных артефактов в `template/` нет. Две
      пустые директории `packages/db/migrations/*/`, оставшиеся от локального
      `prisma migrate dev`, удалены — с ними `migrate deploy` падает с P3015
      (воспроизведено).
