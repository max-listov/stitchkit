---
title: "Async auth rules возвращают типизированные context contributions"
description: Поля, вычисленные внутри async access rule, должны попадать в RuntimeContext и AuthScopes без рукописной карты и повторного resolver-вызова.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 12:53 +00:00
related: docs/research/2026-08-17-rule-computed-fields.md
---

# Async rule context contributions

## Зачем

`AuthScopes<typeof hook>` сегодня выводит только поля синхронного `inject`.
Поля, которые становятся известны внутри async access rule после DB/API lookup
(каноничный resource id, membership role, tenant id), приходится одновременно
писать в `ctx` и дублировать в рукописной scope map. Это возвращает drift,
который derived scopes должны были устранить.

Исследование `docs/research/2026-08-17-rule-computed-fields.md` уже подтвердило
реализуемую форму: правило возвращает `boolean | TFields`, а async-правило —
`Promise<boolean | TFields>`. Проверка доступа и вычисление полей остаются одним
resolver-вызовом.

## Результат

- Function auth rule может вернуть:
  - `false` — отказ через существующий `onForbidden`;
  - `true` — успех без новых полей;
  - plain record — успех и типизированный merge собственных enumerable string
    data-properties в `RuntimeContext`;
  - throw — существующая доменная ошибка проходит без изменения.
- `AuthScopes<typeof hook>` soundly выводит объединение синхронного `inject` и
  async contribution правила. `false | TFields` даёт гарантированные fields;
  если успешный return допускает и `true`, и object либо несколько object
  shapes, негарантированные поля становятся optional — handler не получает
  ложную required-гарантию. Рукописная карта для rule-computed полей не нужна.
- Порядок единственный: `inject` выполняется до rule, contribution мержится
  после успешного rule; при совпадении application-owned ключа contribution
  побеждает и в runtime, и в выведенном типе.
- Один canonical safe context merger предварительно валидирует весь contribution
  и только затем применяет его. `__proto__`, own symbols/accessors и
  framework-owned context keys (`params`, `input`, `source`, `req`, `signal`,
  MCP/trace/runtime facts и их canonical successors) отклоняются fail-closed;
  partial merge невозможен.
- `'public'` в union сохраняет существующую optional/`Partial`-семантику.
- Существующие корректные boolean rules работают без миграции. Breaking note
  перечисляет обе runtime-разницы нетипизированного/невалидного кода: truthy
  object теперь мержится, а ранее falsy значения кроме literal `false`
  (`undefined`, `null`, `0`, `''`) становятся deterministic framework error,
  а не неявным forbidden.

## План

- [x] Зафиксировать решение отдельным ADR, расширяющим ADR 0078: return object
      — access-derived contribution, `inject` — pre-rule identity contribution;
      обновить индекс ADR.
- [x] Расширить `AuthRule`/`ScopedAuthRule` типизированным object-return без
      ослабления boolean-ветки до `unknown` или `any`.
- [x] Добавить distributive type-level extraction из
      `Awaited<ReturnType<rule>>`: required только общие гарантированные поля,
      остальные success-union fields optional; `inject` и rule fields
      объединять как type-level override, а не пересечением конфликтующих
      типов.
- [x] Ввести один safe context-contribution merger для существующих scoped
      `inject` и нового return. До мутации он проверяет plain prototype,
      descriptors, string keys, reserved-key set и полностью готовит merge;
      array, class instance, thenable, accessor, symbol, `__proto__` и proxy
      failure дают fail-closed error без частичной записи.
- [x] В `createAuthHook` после await различать строго `false`, `true` и validated
      plain record. Invalid return получает stable internal diagnostic со scope
      и offending key/type без значения; наружу проходит существующая generic
      framework error без внутренних context/provider данных.
- [x] Сохранить текущие 401/403/throw semantics и синхронность `inject`.
- [x] Добавить runtime tests: async contribution, `{}`, `false`, `true`, throw,
      conflict `inject`/return, все invalid falsy returns, reserved key,
      `__proto__`, array/class/thenable/accessor/symbol/proxy failure, отсутствие
      partial merge и ровно один resolver-вызов.
- [x] Добавить HTTP `authorize` и real tool-runner integration cases: admission,
      merge и error semantics совпадают, а transport phase остаётся своей.
- [x] Добавить type tests: `false | { role }` → required, `true | { role }` →
      optional, union разных object shapes, nested Promise, scoped и bare rule,
      boolean-only rule, `'public'`, shared+scoped inject и rule override.
      Композицию двух auth hooks проверять только на непересекающихся полях:
      last-wins между hooks не является частью этой задачи.
- [x] Проверить inline/hoisted rule и explicit `createAuthHook<User>` fixtures;
      если partial generic inference по-прежнему ограничивает derivation,
      задокументировать это честно вместо ослабления типов.
- [x] Обновить auth/server guide, API reference, generated `llms` и
      `CHANGELOG.md`: `Added` показывает удаление ручной scope map, а
      `⚠️ Breaking changes` отдельно описывает truthy-object merge и invalid
      falsy returns с механическим before → after.
- [x] Провести изменение как breaking minor по правилам pre-1.0; релиз в эту
      задачу не входит.

## Acceptance

- [x] Async access resolver возвращает вычисленные поля один раз; handler
      получает их типизированными через `AuthScopes<typeof hook>` без ручной
      scope map и без второго DB/API lookup.
- [x] Runtime и type-level порядок совпадают: rule contribution заменяет только
      одноимённое application field `inject`; framework-owned fields и prototype
      не могут быть изменены.
- [x] Mixed `true | object` и object unions никогда не дают handler-у ложную
      required-гарантию.
- [x] `false`, anonymous identity, thrown domain error и `'public'` ведут себя
      так же, как до изменения.
- [x] Нет нового `as` вне разрешённых typed boundaries и нет `any` в публичной
      сигнатуре.
- [x] Invalid return даёт deterministic caller-safe framework error, оставляет
      context неизменённым и пишет actionable internal diagnostic без values.
- [x] Exact runtime/type test cases перечислены в `Что сделано` при закрытии.
- [x] `bun run verify` зелёный.

## Что сделано

- Добавлен атомарный typed contribution merge для sync/async auth rules с запретом framework-owned, unsafe, symbol и accessor keys.
- AuthScopes<typeof hook> выводит required/optional contribution fields без ручной scope map; HTTP и tool paths используют один механизм.
- Обновлены ADR 0085, auth guide, API reference, changelog, packed consumer и public type fixtures.
- Type-level coverage: packages/core/tests/scoped-implement.type-test.ts.
- [x] Регрессия: packages/core/tests/auth-hook.test.ts::an async rule contributes access-derived fields exactly once; packages/core/tests/auth-hook.test.ts::the same rule contribution is available on the tool path; packages/core/tests/auth-hook.test.ts::false and a thrown domain error never merge rule-returned fields; packages/core/tests/auth-hook.test.ts::reserved keys reject the complete contribution before any merge; packages/core/tests/auth-hook.test.ts::unsafe, symbol and accessor keys fail without invoking a getter; packages/core/tests/auth-hook.test.ts::a hostile proxy produces a stable inspection error
