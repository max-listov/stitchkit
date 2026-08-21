---
title: Типизированное объявление хендлеров без биндинга — компаньон реестра
description: declareHandlers закрывает дыру реестрового пути — сервисный файл объявляет типизированные хендлеры, а биндит их реестр; потребительская самописная handlersFor исчезает.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 15:55 +00:00
related: docs/decisions/0075-per-scope-handler-context.md
---

# `declareHandlers` — компаньон реестра

## Зачем

`createScopedImplementRegistry` биндит контракты к хендлерам в одной точке —
это его смысл («нельзя забыть сервис», `.byKey`). Но тогда файл сервиса должен
отдать **несвязанные, но типизированные** хендлеры, а такого примитива у нас
нет. Первый же реестровый потребитель дописал его сам:

```ts
// потребительский transport/define.ts — 8 строк, которые напишет каждый
export function handlersFor<
  const T extends Record<string, EndpointDef>,
  TScope extends Extract<keyof ApplicationScopes, string>,
>(_contract: ContractDef<T, TScope>) {
  return <const H extends ScopedHandlers<T, TScope, ApplicationScopes>>(handlers: H): H =>
    handlers;
}
```

Каррирование здесь не стиль, а ограничение TS: в одном вызове нельзя и принять
контракт, и вывести `H` контекстно по нему. Второй потребитель (`implementFor`,
без реестра) в этом не нуждается — расхождение между ними именно в
недостающей половине реестрового пути. Это тот же класс дыры, что закрытая
самописная машина сигналов: потребитель дописывает кусок примитива, и наверняка
хуже (без `const H`, с потерей точности вывода).

## Результат

- У фабрики scoped-реестра (или рядом с ней) появляется типизированный способ
  объявить хендлеры одного контракта без биндинга — например
  `const scoped = createScopedImplement<Scopes>()` даёт
  `scoped.declare(contract)(handlers)` (форма — решить при реализации: метод на
  фабрике против отдельного `createHandlersDeclaration<Scopes>()`; метод
  предпочтительнее — карта скоупов уже зафиксирована фабрикой, второй раз её не
  называют).
- Возвращаются ровно переданные хендлеры с сохранённой точностью типов
  (`const H`), пригодные для `createScopedImplementRegistry` и для прямого
  `implementFor(contract, handlers)`.
- Самописная `handlersFor` у потребителя удаляется без потери типизации.
- Аддитивно; `ScopedHandlers` уже экспортирован — меняется только эргономика.

## План

- [x] Выбрать форму (метод на фабрике, по образцу `implementFor.stream`) и
      реализовать в `packages/core/src/server/implement.ts`.
- [x] Type-test: контекстная типизация `ctx`/`input` внутри `declare` идентична
      прямому `implementFor` (позитив + `@ts-expect-error` на чужом поле и
      неизвестном скоупе); рантайм-тест: результат `declare` биндится реестром
      и даёт те же `ServiceDef`, что прямой вызов.
- [x] Проверить, что `const H` сохраняет литеральность и excess-property
      контроль (лишний хендлер — ошибка на объявлении, не на биндинге).
- [x] `docs/guide/server.md` (реестровый раздел — показать пару
      `declare` + реестр как канонический путь), `docs/api/reference.md`,
      `public-surface.json`, CHANGELOG `### Added`.

## Acceptance

- [x] Сервисный файл объявляет типизированные хендлеры без биндинга и без
      единого самописного типового хелпера.
- [x] Реестр принимает объявленное без потери проверок missing/extra.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `createScopedImplement(...).declare(contract)(handlers)` —
      `packages/core/src/server/implement.ts`, метод на фабрике (форма выбрана
      по образцу `.stream`: карта скоупов уже зафиксирована, второй раз не
      называется). Лишний хендлер режется валидатор-пересечением
      `Record<Exclude<keyof THandlers, keyof T>, never>` **на объявлении** —
      generic-констрейнт сам по себе EPC не даёт, поэтому пересечение
      обязательно.
- [x] Type-test `packages/core/tests/scoped-implement.type-test.ts`
      (секция declare): типизация идентична прямому вызову; объявленное
      биндится и реестром, и напрямую; чужое поле, лишний хендлер и
      недостающий хендлер — ошибки на объявлении.
- [x] Рантайм: `packages/core/tests/scoped-implement-registry.test.ts::declare — handlers without binding > a declared handler object binds to the same services as inline handlers`
      — включая streaming-эндпоинт через `.stream`.
- [x] `docs/guide/server.md` (реестровый сниппет показывает пару
      declare + реестр), `docs/api/reference.md` (строка `createScopedImplement`
      упоминает обе формы), CHANGELOG `[Unreleased]` → `### Added`.
      Новых экспортов нет — `public-surface.json` не менялся.
- [x] Аддитивно; релиз не делался по условию конвейера.
