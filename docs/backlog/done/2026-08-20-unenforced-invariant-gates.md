---
title: "Три инварианта держатся на внимательности, а не на гейте"
description: Новый entrypoint stitchkit/files вне реестра деклараций, reserved-ключи контекста не запинены к RuntimeContext, штамп completed в done не проверяется.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 15:17 +00:00
---

# Незакрытые гейты инвариантов

## Зачем

Валидация стейджа нашла три места, где правило проекта соблюдено сегодня, но
ничем не удерживается завтра.

1. **`stitchkit/files` не попал в `packages/core/scripts/check-public-types.mjs`.**
   Реестр перечисляет девять entrypoint'ов и в этом же батче получил
   `stitchkit/remote`, но не `files.d.ts`. Это ровно тот гейт, который в 0.50.0
   поймал утечку `NodeJS.Signals` в опубликованные декларации. Внутри
   `files/boundary.ts` есть `Awaited<ReturnType<typeof open>>` (node:fs
   FileHandle) — сегодня он не выходит в публичную сигнатуру, но ничто этого не
   держит.
2. **`RUNTIME_CONTEXT_RESERVED_KEYS` не запинен к `RuntimeContext`.** Набор из
   14 ключей сейчас совпадает с объявленными полями точь-в-точь (сверено), и от
   него зависят два места: merge auth-contribution и фильтрация path-параметров
   (`server/context.ts`). Новое поле в `RuntimeContext` молча останется
   незащищённым.
3. **Штамп `completed:` в `done/` не проверяется.** `docs-hygiene.test.ts`
   стережёт незакрытые чекбоксы и аттестации регрессий, но не дату завершения —
   поэтому пять доков этого батча уехали в `done/` без неё.

## Результат

- Каждый публичный entrypoint автоматически участвует в проверке деклараций;
  добавление entrypoint без записи в реестр падает.
- Расхождение reserved-набора с объявленными полями `RuntimeContext` падает
  тестом с именем недостающего ключа.
- Док в `done/` без `completed:` падает гейтом гигиены.

## План

- [x] `check-public-types.mjs`: убрать ручной реестр и вывести все declaration
      entrypoint'ы напрямую из `package.json#exports`, чтобы `stitchkit/files`
      и каждый будущий export участвовали автоматически.
- [x] Тест drift: набор `RUNTIME_CONTEXT_RESERVED_KEYS` сравнивается с ключами,
      объявленными в `RuntimeContext` (через тип-уровневый список либо парс
      `contract/define.ts`); расхождение в любую сторону — падение с именем ключа.
- [x] `docs-hygiene.test.ts`: у каждого файла в `docs/backlog/done/` frontmatter
      содержит `status: done` и непустой `completed:`.
- [x] Прогнать гейты на текущем дереве и починить то, что они найдут
      (ожидаемо: пять доков без `completed:` — см. отдельную таску).

## Acceptance

- [x] Ручной реестр entrypoint'ов удалён: каждый declaration target из
      `package.json#exports` автоматически входит в гейт.
- [x] Добавление поля в `RuntimeContext` без обновления reserved-набора делает
      тест красным.
- [x] Док в `done/` без `completed:` делает гейт красным.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Declaration gate: `packages/core/scripts/check-public-types.mjs` строит
      entrypoint map напрямую из `packages/core/package.json#exports`; build
      подтвердил в том числе peer-free `stitchkit/files`.
- [x] Context gate: `packages/core/tests/auth-hook.test.ts` парсит каноническое
      объявление `RuntimeContext` и сравнивает его поля с
      `RUNTIME_CONTEXT_RESERVED_KEYS` в обе стороны.
- [x] Backlog gate: `packages/core/tests/docs-hygiene.test.ts` проверяет
      `status: done` и непустой `completed:` у каждого done task.
- [x] Регрессия: packages/core/tests/auth-hook.test.ts::reserved context keys exactly match the declared RuntimeContext fields; packages/core/tests/docs-hygiene.test.ts::every done task has done status and a completed timestamp
