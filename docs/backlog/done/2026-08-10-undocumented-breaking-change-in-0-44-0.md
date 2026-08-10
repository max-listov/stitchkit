---
title: "Undocumented breaking change in 0.44.0"
description: "authorizeUser получил обязательный approvedScopes без breaking-секции, и JS-потребитель молча выпускает токены с пустым скоупом."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# Undocumented breaking change in 0.44.0

## Зачем

`authorizeUser` сменил тип возврата с `{ userId } | Response` на
`{ userId, approvedScopes: readonly string[] } | Response`
(`tools/oauth-provider.ts:227` против `v0.43.1`, коммит `b4d4f6a`).
`approvedScopes` обязателен, но не упомянут ни в `CHANGELOG.md`, ни в
`docs/guide/upgrading.md`.

Это ломает собственный контракт репозитория: `upgrading.md:33-36` инструктирует
агента, что версия без секции `### ⚠️ Breaking changes` аддитивна и её можно
пропустить.

Изменилось и поведение: раньше сохранялся **запрошенный** скоуп
(`v0.43.1:oauth-provider.ts:377`), теперь — только то, что вернул колбэк
(`:813,821`). JS-потребитель, продолжающий возвращать `{ userId }`, получает
`approvedScopes === undefined` → токены выпускаются с **нулевым набором скоупов**
→ каждый вызов со скоупом отклоняется, и нигде ничего не бросает. Fail-closed, но
молча. TypeScript-потребитель ошибку компиляции получит — это смягчает, но не
снимает.

Рядом путаница в самом файле миграций: релизная 0.44.0 описана под заголовком
`## Unreleased breaking migrations` (`upgrading.md:63`), тогда как `:265` заявляет
«Historical … through 0.43.1». Агент, читающий документ рационально, пропускает
всю миграцию 0.44.0.

## Результат

- Разрыв в `authorizeUser` описан по конвенции: секция с точным заголовком и
  before → after.
- Раздел миграций отражает, что 0.44.0 выпущена, а не «unreleased».
- JS-потребитель, не вернувший `approvedScopes`, получает громкий отказ, а не
  тихо пустой скоуп.

## План

- [x] Внести в `CHANGELOG.md` под 0.44.0 секцию `### ⚠️ Breaking changes` с
      before → after по `authorizeUser`, включая смену источника сохраняемого
      скоупа (запрошенный → одобренный).
- [x] Перенести миграцию 0.44.0 из «Unreleased» в выпущенные и выровнять фразу
      про «Historical … through …».
- [x] Валидировать возврат `authorizeUser` на границе: отсутствующий или не
      массив `approvedScopes` — ошибка конфигурации, а не пустой набор.
- [x] Тест: колбэк вернул `{ userId }` без `approvedScopes` → громкий отказ, а не
      токен с пустым скоупом.
- [x] Проверить остальной диф 0.44.0 (~1781 строка) на такие же поведенческие
      изменения без записи: типовая поверхность уже проаудирована, поведение —
      выборочно.

## Acceptance

- [x] Секция breaking для 0.44.0 существует и содержит рабочие before → after.
- [x] Раздел миграций не относит выпущенную версию к неопубликованным.
- [x] Тест доказывает громкий отказ при отсутствующем `approvedScopes`.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: CHANGELOG.md and docs/guide/upgrading.md.
- [x] Регрессия: packages/core/tests/oauth.test.ts::a JavaScript authorizeUser without approvedScopes fails loudly
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
