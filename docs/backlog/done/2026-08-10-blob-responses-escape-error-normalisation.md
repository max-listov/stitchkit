---
title: "Blob responses escape client error normalisation"
description: "Отсутствующий await на пути responseType blob уводит сетевую ошибку мимо catch, ApiError и подписчиков клиента."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:00 +07:00
---

# Blob responses escape client error normalisation

## Зачем

```ts
// packages/core/src/browser/http.ts:244
try {
  if (options.responseType === 'blob') {
    return client[method](url, kyOptions).blob() as Promise<T>;
  }
```

Промис не дожидается внутри `try`, поэтому отказ наступает уже после выхода из
блока, и `catch` на `:267` — тот самый, что превращает ошибку в `ApiError` и
публикует событие `network_error` — не выполняется.

Замер одним и тем же клиентом против недоступного хоста, три типа ответа:

```
json : ApiError  code=UNKNOWN_ERROR      status=0   events: ["network_error"]
blob : Error     code=ConnectionRefused             events: []        ← оба поля неверны
resp : ApiError  code=UNKNOWN_ERROR      status=0   events: ["network_error"]
```

Сценарий: браузер скачивает файл с `responseType: 'blob'` при пропавшей сети.
`ApiError.is(err)` даёт `false`, поэтому error boundary приложения, построенный на
`ApiError`, эту ошибку пропускает; а офлайн-баннер, подписанный через
`client.subscribe()`, не загорается — и только для blob-загрузок.

Ошибки из конверта на этом пути всё же всплывают корректно, потому что их бросает
собственный `afterResponse`-хук ky — это и маскирует дефект при беглой проверке.

Скрыл его от компилятора каст `as Promise<T>`: это assertion вне тех граничных
мест, которые санкционирует `AGENTS.md`. Тестов на `responseType: 'blob'` в
`packages/core/tests` нет.

## Результат

- Сетевой отказ на blob-пути нормализуется так же, как на json и response:
  `ApiError` с кодом и статусом, событие `network_error` у подписчиков.
- Каст `as Promise<T>` на этом пути исчезает вместе с причиной, по которой он
  понадобился.

## План

- [x] Дождаться промиса внутри `try` (`return await …blob()`), убрав каст;
      если тип не сходится без него — чинить сигнатуру, а не подавлять.
- [x] Проверить остальные ветки `responseType` на тот же паттерн
      «return без await внутри try».
- [x] Тест: недоступный хост на каждом `responseType` (`json`, `blob`,
      `response`) даёт `ApiError.is(err) === true` и ровно одно событие
      `network_error`.
- [x] Тест: ошибка из конверта на blob-пути по-прежнему приходит как `ApiError`
      с кодом сервера (регрессия не должна съесть работающий путь).
- [x] `CHANGELOG.md` → `### Fixed`.

## Acceptance

- [x] Три типа ответа дают одинаковую форму ошибки и одинаковый набор событий.
- [x] В `browser/http.ts` не осталось `as Promise<…>` на путях ответа.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/browser/http.ts and packages/core/src/internal/typed.ts.
- [x] Регрессия: packages/core/tests/api-error-trace.test.ts::all response decoders normalize an unreachable host identically; packages/core/tests/api-error-trace.test.ts::the blob decoder preserves a structured server ApiError; packages/core/tests/api-error-trace.test.ts::a malformed JSON body on the DEFAULT path is normalized like every other failure
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

**Заявленная зачистка паттерна не выполнена.** `[x] Проверить остальные ветки
`responseType` на тот же паттерн «return без await внутри try»` — самый крупный
экземпляр остался: `browser/http.ts:266` → `return response.json<T>();` без `await`,
внутри того же `try`. Кривой JSON минует `catch` ровно так же, как раньше минул blob.

Ветки `blob` и `response` действительно починены, каст `as Promise<T>` убран,
два новых теста на три типа ответа настоящие.

### Осталось сделать

- [x] `browser/http.ts:266` → `return await response.json<T>()` с комментарием;
      файл прочёсан целиком (`grep` на `return …(json|blob|text|arrayBuffer)` без
      `await`) — других экземпляров паттерна нет.
- [x] Тест: `packages/core/tests/api-error-trace.test.ts::a malformed JSON body
      on the DEFAULT path is normalized like every other failure` — сервер отдаёт
      битый JSON, дефолтный путь даёт `ApiError` + ровно одно `network_error`;
      недоступный хост на трёх типах уже закрыт `::all response decoders
      normalize an unreachable host identically`.

**Финальная проверка 2026-08-10:** `bun test api-error-trace client` — 28 pass;
`tsc --noEmit` чистый.
