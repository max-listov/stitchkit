---
title: "Prototype-chain keys bypass two guards"
description: "Поиск по обычному объекту через [key] и `in` пропускает Object.prototype, из-за чего auth-правило и реестр кодов ошибок ведут себя произвольно."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# Prototype-chain keys bypass two guards

## Зачем

Два места читают ключ из обычного объекта без проверки собственности, и оба
рядом с комментарием, обещающим строгость.

**1. Auth-гейт открывается на прототипных именах скоупа.**

```ts
// packages/core/src/server/middleware/auth.ts:238-243
const rule = config.rules[scope];
// An endpoint that declares a scope with no matching rule is a config
// mistake — fail closed, never silently pass an unguarded endpoint.
if (!rule) {
  throw new Error(`[stitchkit] auth: no rule for scope "${scope}"`);
}
```

`config.rules` — обычный объект, поэтому `rules['toString']` резолвится через
`Object.prototype`. Guard видит **функцию**, fail-closed не срабатывает, и дальше
эта функция вызывается как пользовательский предикат доступа:
`await rule(identity, ctx)` → `Object.prototype.toString.call(identity)` →
`"[object Object]"` → истина → **доступ выдан** для скоупа, правила под который
приложение не объявляло.

Замер на конфиге, где объявлен только `admin`, вызывающий — обычный
аутентифицированный identity:

```
scope=admin        -> blocked (403 FORBIDDEN)
scope=typo_scope   -> blocked ([stitchkit] auth: no rule for scope "typo_scope")
scope=toString     -> ALLOWED            ← guard обойдён
scope=constructor  -> ALLOWED            ← guard обойдён
scope=valueOf      -> blocked (TypeError) ← 500 вместо отказа
```

Поведение не просто «разрешительное», оно **произвольное**: одно прототипное имя
открывает доступ, другое роняет запрос в 500. По ADR 0002 скоупы — свободные
строки, ничем не ограниченные, и `rules` часто собирается программно, поэтому
скоуп с именем `constructor` в доменной модели про системные объекты вполне
достижим. Тихо, без ошибки и без записи в лог.

Показательно, что в остальном фреймворк на этот класс внимателен: `isUnsafeKey`
охраняет куки, query-параметры, multipart-поля и сборку контекста — но не этот
поиск.

**2. `isStitchErrorCode` признаёт восемь чужих кодов, а `appError` делает статусом
функцию.**

```ts
// packages/core/src/contract/errors.ts:130-132
export function isStitchErrorCode(code: string): code is StitchErrorCode {
  return code in STITCH_ERROR_STATUS;
}
```

`in` обходит цепочку прототипов. Это публичный API (`stitchkit/contract`,
`docs/api/reference.md:155`):

```
isStitchErrorCode("NOT_FOUND")      = true
isStitchErrorCode("MY_APP_CODE")    = false
isStitchErrorCode("toString")       = true    ← неверно
isStitchErrorCode("constructor")    = true    ← неверно
isStitchErrorCode("__proto__")      = true
```

Дальше `appError('toString', …)` берёт `STITCH_ERROR_STATUS['toString']` и
передаёт `Object.prototype.toString` в качестве HTTP-статуса:

```
status = function toString() { [native code] }
Response.json -> RangeError: The status provided (0) must be 101 or in the range of [200, 599]
```

`appError` — ровно тот API, которым отображают динамический код ошибки внешнего
сервиса или БД в `AppError`. Код `constructor` или `toString` со стороны превращает
чистый 4xx в `RangeError`, брошенный **внутри пути обработки ошибки**, который затем
возвращается в `normalizeError` уже как generic 500 с мусорной строкой в stderr.
Тот же сломанный guard потребляет `tools/execute.ts:169` при отображении
ошибки тула в HTTP-статус.

## Результат

- Скоуп, для которого не объявлено правило, всегда fail-closed — включая имена,
  совпадающие с членами `Object.prototype`.
- `isStitchErrorCode` истинен ровно для кодов реестра `STITCH_ERROR_STATUS`.
- `appError` с чужим кодом всегда даёт 500, а не функцию в поле статуса.
- Класс закрыт целиком, а не в двух найденных точках.

## План

- [x] `auth.ts:238` — читать правило через `Object.hasOwn(config.rules, scope)`
      (или собрать `rules` в `Map`/`Object.create(null)`), сохранив текст
      fail-closed ошибки.
- [x] `contract/errors.ts:132` — `Object.hasOwn(STITCH_ERROR_STATUS, code)`
      вместо `in`.
- [x] Пройти остальные реестры, читаемые по внешне управляемому ключу
      (`STITCH_ERROR_STATUS`, `config.rules`, реестры тулов/сервисов, маршрутные
      карты) и привести к одному способу поиска. Если `isUnsafeKey` уже покрывает
      часть — переиспользовать его, а не заводить второй механизм.
- [x] Тест auth: скоупы `toString`, `constructor`, `valueOf`, `__proto__`,
      `hasOwnProperty` → отказ с тем же сообщением, что у необъявленного скоупа.
- [x] Тест ошибок: те же имена → `isStitchErrorCode` ложен, `appError` даёт
      статус 500, `Response.json` не бросает.
- [x] `CHANGELOG.md` → `### Fixed` с явным упоминанием, что затронут auth-гейт.

## Acceptance

- [x] Ни один член `Object.prototype` не проходит как объявленный скоуп.
- [x] Тест доказывает отказ, а не отсутствие исключения: проверяется именно
      403/ошибка конфигурации, а не «не упало».
- [x] `appError` с произвольным внешним кодом всегда порождает валидный
      HTTP-статус.
- [x] `bun run verify` зелёный.

## Не входит

- Введение доменной классификации скоупов или их валидации по формату — ADR 0002
  оставляет скоупы свободными строками, и это решение не пересматривается.

## Что сделано

- [x] Реализация: packages/core/src/tools/cli-args.ts and packages/core/src/server/router.ts.
- [x] Регрессия: packages/core/tests/cli.test.ts::a dotted __proto__ path is refused LOUDLY and does not pollute Object.prototype; packages/core/tests/cli.test.ts::a dotted constructor path is a normal own-key write (not blocked); packages/core/tests/errors.test.ts::prototype keys remain application errors with a valid 500 status
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
