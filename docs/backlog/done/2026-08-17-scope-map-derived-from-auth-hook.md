---
title: Карта скоупов выводится из createAuthHook, а не пишется рядом с ним
description: Типизированный per-scope inject у auth-хука становится единственным источником правды о полях контекста; createScopedImplement потребляет его вместо рукописной карты.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 14:51 +00:00
related: docs/decisions/0075-per-scope-handler-context.md
---

# Карта скоупов выводится из `createAuthHook`

## Зачем

Оба первых внедрения `createScopedImplement` (два независимых потребителя, один
день) упёрлись в одно и то же место, которое ADR 0075 честно назвал принятым
следствием: карта `scope → поля` — **утверждение приложения, которое фреймворк
не проверяет**. Первый потребитель ошибся в рукописной карте и компилятор
наказал невиновные хендлеры; второй при сверке черновика карты с фактическим
`inject` нашёл расхождение **в четырёх скоупах из шести**. Его формулировка
точна: «я поменял одну большую ложь суперсета на шесть маленьких непроверяемых».

Корень: у приложения уже есть место, где вклад в контекст объявлен **делом** —
`createAuthHook` (`rules` per-scope + `inject` в до-измененной форме;
теперь [middleware/auth.ts](../../../packages/core/src/server/middleware/auth.ts)
содержит решение). Карта
`createScopedImplement` — второе, параллельное описание той же правды. Два
ручных описания одного факта обречены разъезжаться — ровно тот дефект, который
0.75 закрывал на стороне хендлеров.

Отложенный пункт ADR 0075 («карта не проверяется рантаймом») получил то самое
«real demand», которого не хватало.

## Результат

- `createAuthHook` умеет объявлять вклад в контекст типизированно и
  **per-scope** (сейчас `inject` один на все правила и нетипизирован —
  `(ctx, identity) => void`).
- Из хука выводится тип карты скоупов; `createScopedImplement` может принять его
  вместо рукописной карты: `createScopedImplement<ScopesOf<typeof authHook>>()`
  или прямая композиция. Рукописная карта остаётся как fallback для приложений
  без auth-хука.
- Правило `'public'` в выведенной карте даёт **опциональные** поля инжекта:
  семантика public у хука — «не отвергать анонима», а не «identity не бывает»
  (resolve и inject выполняются и там). Это закрывает и вторую жалобу первого
  потребителя (`public: object` толкает к кастам законные `ctx.sessionId` в
  public-эндпоинтах auth-контракта).
- Дизайн — через ADR: это изменение публичной формы `AuthHookConfig`, вариантов
  минимум два (типизированный per-rule `inject` vs декларация полей на правиле),
  и выбирать между ними надо письменно.

## План

- [x] ADR: как правило объявляет вклад (per-rule `inject` с выводимым типом
      возврата против декларативного списка полей), как связывается с
      `createScopedImplement`, что происходит при смешении (часть скоупов от
      хука, часть руками).
- [x] Реализация выбранного варианта в `middleware/auth.ts` — аддитивно,
      существующий одиночный `inject` продолжает работать.
- [x] Типовой хелпер вывода карты + приём в `createScopedImplement`.
- [x] `'public'`-правило ⇒ `Partial<>` полей в выведенной карте.
- [x] Type-тесты: вывод карты, опциональность public, ошибка на скоупе, которого
      нет в rules.
- [x] Гайды (`auth-and-errors.md`, `server.md` — раздел createScopedImplement),
      reference, ADR-индекс, CHANGELOG.

## Acceptance

- [x] Приложение с `createAuthHook` может не писать карту руками вообще;
      расхождение «hook инжектит X, хендлер видит Y» становится невозможным по
      построению.
- [x] Рукописная карта по-прежнему работает (fallback зафиксирован тестом).
- [x] `bun run verify` зелёный.

## Что сделано

### Core (`packages/core/src/server/middleware/auth.ts`)

- [x] `ScopedAuthRule<TIdentity, TFields>` — объектная форма правила
      `{ rule, inject? }`; `inject(identity, ctx)` возвращает поля скоупа,
      рантайм мержит их в контекст **до** проверки правила и только при
      резолвнутой identity (в том числе на `'public'`).
- [x] `AuthRules<TIdentity>`, `RuleScopes<TRules>` — вывод карты: `'public'` ⇒
      `Partial<F>`, остальные правила ⇒ `F`, голое правило ⇒ `object`.
- [x] `createAuthHook` получил `const TRules` и возвращает
      `ScopedAuthHook<RuleScopes<TRules>>` (type-only маркер `'~scopes'`);
      `AuthScopes<typeof hook>` скармливается `createScopedImplement` без
      единого изменения в нём. Ни одного `as`.
- [x] Обратная совместимость: `AuthHookConfig` — второй параметр с дефолтом,
      существующие вызовы компилируются; явный дженерик identity отключает
      вывод (у TS нет частичной инференции) — рукописная карта остаётся
      fallback, это записано в ADR и гайде.

### Тесты

- [x] `packages/core/tests/auth-hook.test.ts::createAuthHook — scoped rules with typed inject`
      — 5 кейсов: merge полей; public инжектит залогиненному и пропускает
      анонима; кастомное правило реджектит после своего inject; admin-поля;
      голое правило работает рядом.
- [x] `packages/core/tests/scoped-implement.type-test.ts` — связка
      `AuthScopes<typeof hook>` → `createScopedImplement`: точная типизация
      полей по скоупам, optional под public (`@ts-expect-error` на `string`),
      скоуп без правила — ошибка компиляции.

### Документация

- [x] ADR `docs/decisions/0078-scope-map-derived-from-the-auth-hook.md`
      (+ строка в индексе). Включает отклонение runtime drift-предупреждения.
- [x] `docs/guide/auth-and-errors.md` — раздел «Scoped rules», включая
      семантику public (закрывает жалобу №2 первого потребителя).
- [x] `docs/guide/server.md` — раздел `createScopedImplement` направляет к
      выводу карты вместо рукописной.
- [x] `docs/api/reference.md` — 5 новых строк; `public-surface.json` обновлён.
- [x] `CHANGELOG.md` `[Unreleased]` → `### Added`. Аддитивно, без breaking.

### Дефекты, найденные батч-валидаторами (все исправлены)

- [x] **Union-rule был unsound**: `rule: flag ? 'public' : 'authenticated'` +
      inject давал required-поля, а рантайм при анониме inject пропускал —
      `undefined` под типом `string`. `RuleScopes` теперь проверяет
      **членство** `'public'` в типе правила (`'public' extends
      Extract<TRule, string>`), union даёт `Partial`. Закреплено:
      `scoped-implement.type-test.ts` (union-кейс) и
      `auth-hook.test.ts::createAuthHook — scoped rule edges > a union rule that lands on public at runtime skips inject for the anonymous`.
- [x] **Async inject был тихим no-op**: `Promise extends object`, а
      `Object.assign(ctx, promise)` не мержит ничего. Теперь тип запрещает
      thenable (`TFields & { then?: never }`), рантайм бросает для нетипизированных
      вызовов. Закреплено: type-test `@ts-expect-error` и
      `auth-hook.test.ts::… > an async inject from an untyped caller throws instead of merging a Promise`.
- [x] Гайд примирён со старым советом `satisfies`: расширенная форма
      `AuthRule<User> | ScopedAuthRule<User, object>` названа явно (деривацию
      не убивает — проверено валидаторской пробой), добавлены заметки про
      чистоту/синхронность inject, inline-правила и композицию двух хуков
      пересечением карт.
- [x] ADR 0078 дополнен обоими ужесточениями и границей «поля из async-правила
      остаются рукописной карте».
