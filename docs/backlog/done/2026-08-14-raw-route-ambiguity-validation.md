---
title: Fail-first validation конфликтов raw routes
description: Ловить неоднозначные и полностью затенённые raw HTTP routes при сборке сервера.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 13:47 +00:00
---

# Raw route ambiguity validation

## Зачем

Contract routes уже проходят структурную проверку, а raw routes сейчас проверяют
главным образом корректность trailing wildcard. Два raw route могут иметь один
`method + path`, одинаковую форму с разными именами params или быть полностью
затенены более ранним wildcard. Ошибка проявляется только в runtime и зависит от
порядка массива, хотя framework способен обнаружить её при startup.

## Результат

`validateRawRoutes()` fail-first отклоняет только доказанно неоднозначные или
недостижимые raw routes. Допустимая композиция «specific route перед более общим
wildcard» продолжает работать. Project-specific allowlist и смысл маршрута
остаются в приложении.

## План

- [x] Введена общая канонизация route shape: HTTP method, static segments,
  param segments и trailing wildcard без зависимости от имени param.
- [x] Exact duplicate `method + path` отклоняется.
- [x] Эквивалентные param shapes, например `/users/:id` и
  `/users/:userId`, отклоняются для одного метода.
- [x] Реализован алгоритм полного shadowing с учётом порядка raw routes и
  trailing wildcard; частичное пересечение не объявляется конфликтом.
- [x] Семантика методов согласована с реальным router без отдельной модели
  правил валидатора.
- [x] Сохранены существующие проверки raw-vs-contract routes; второй
  несовместимый route matcher не создавался.
- [x] Ошибка содержит конфликтующие method/path и точную причину конфликта.
- [x] Добавлены table-driven tests на static, params, named/trailing wildcard,
  method separation, legal specific-before-wildcard и illegal shadowing.
- [x] Обновлены server guide и changelog; validator остался internal, поэтому
  отдельного public API entry в reference не добавлялось.

## Не входит

- Списки разрешённых raw routes конкретного приложения.
- Классификация `business | infrastructure`.
- Проверка framework identity: `RawRoute` не объявляет service/action identity.
- Запрет любого пересечения wildcard — только доказанная недостижимость.

## Acceptance

- [x] Exact и normalized-shape duplicates падают при создании handler/server.
- [x] Полностью затенённый более поздний raw route падает с точным объяснением.
- [x] Specific route, объявленный до общего wildcard, остаётся валидным и
  маршрутизируется как прежде.
- [x] Одинаковые path shapes для разных независимых HTTP methods разрешены в
  соответствии с router semantics.
- [x] Проверка использует ту же сегментацию и wildcard semantics, что `matchRoute()`.
- [x] Existing raw/contract shadow diagnostics не регрессируют.
- [x] Полный `bun run verify` зелёный.

## Что сделано

- [x] **Router:** `packages/core/src/server/router.ts` использует общие
  segment/shape primitives для matching и startup validation raw routes.
- [x] **Fail-first:** `createHandler()` отклоняет exact duplicates,
  parameter-equivalent shapes и полностью затенённые более поздние routes с
  method/path diagnostics.
- [x] **Legal composition:** разные HTTP methods, specific-before-wildcard и
  GET-before-ALL остаются разрешёнными.
- [x] **Tests:** `packages/core/tests/raw-route-validation.test.ts` покрывает
  `rejects exact duplicate raw routes`,
  `rejects parameter-equivalent route shapes`,
  `rejects a later route fully shadowed by an earlier wildcard` и legal ordering
  cases, включая named trailing wildcards.
- [x] **Docs:** обновлены `docs/guide/server.md` и `CHANGELOG.md`.
- [x] **Что не делалось:** project allowlist, domain classification и public raw
  identity не добавлялись; release, commit, push и deploy не выполнялись.
