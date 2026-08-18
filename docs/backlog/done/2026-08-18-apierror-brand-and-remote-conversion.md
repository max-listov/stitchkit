---
title: "ApiError.is через бренд + честная конверсия в implementRemote"
description: Кросс-чанковый instanceof убивает ветку ApiError→AppError в implementRemote — любая удалённая ошибка схлопывается в INTERNAL_SERVER_ERROR; плюс transformArgs вне try и потеря traceId при конверсии.
type: task
status: done
created: 2026-08-18
updated: 2026-08-18
completed: 2026-08-18 19:30 +07:00
---

# ApiError-бренд и конверсия в implementRemote

## Зачем

Bug report потребителя (CLI поверх `implementRemote`), воспроизведён и
подтверждён по source:

1. **`ApiError.is` — это `instanceof`** (`browser/http.ts:37-39`), а
   опубликованный dist несёт **два независимых объявления класса** (граф
   build:browser, откуда consumer берёт `createHttpClient`, и граф
   build:server, откуда `tools.js` импортирует `ApiError`). Объект одного
   графа не instanceof класса другого → ветка конверсии
   `ApiError → AppError` в `tools/remote.ts:118` мертва → `normalizeError`
   схлопывает любую удалённую ошибку в `INTERNAL_SERVER_ERROR` с сырым
   стеком; дифференцированные exit-коды CLI недостижимы. У `AppError` ровно
   эта проблема уже решена брендом `Symbol.for('stitchkit.AppError')`
   (ADR 0032) — `ApiError` просто не был покрыт тем же решением.
2. **`transformArgs` вызывается ДО `try`** (`tools/remote.ts:106-109`) —
   ошибки хука не проходят конверсию даже после фикса бренда.
3. **`AppError` не несёт `traceId`** — `ApiError.traceId` (из
   `x-request-id`) теряется при конверсии.

## Результат

- `ApiError.is` узнаёт экземпляр из любого чанка/realm (бренд
  `Symbol.for('stitchkit.ApiError')`, зеркально ADR 0032).
- `transformArgs` внутри `try` — ошибки хука конвертируются как ошибки вызова.
- `AppError` получает опциональный `readonly traceId`; конверсия в
  `implementRemote` его сохраняет. Envelope (`toJSON`) не меняется —
  traceId остаётся транспортной метаинформацией.
- Patch-релиз 0.53.1; потребитель бампает зависимость без обходов.

## План

- [x] `browser/http.ts`: бренд + `is` по бренду; комментарий-ссылка на ADR 0032.
- [x] `contract/errors.ts`: `traceId?: string` шестым параметром конструктора
      (аддитивно), readonly-поле; `toJSON` без изменений.
- [x] `tools/remote.ts`: `transformArgs` внутрь `try`; конверсия передаёт
      `err.traceId`.
- [x] Тесты: бренд-кросс-чанк (по образцу `app-error-brand.test.ts` — чужой
      экземпляр с тем же брендом узнаётся, голый Error — нет); конверсия в
      `implementRemote` для «чужого» ApiError (репро мёртвой ветки) с
      сохранением code/status/hint/traceId; throw из `transformArgs`
      нормализуется.
- [x] CHANGELOG `[Unreleased]` (Fixed), verify, tag `v0.53.1`, зелёный CI+npm.

## Acceptance

- [x] Тест «ApiError из другого чанка конвертируется в AppError с исходным
      code/status/traceId» зелёный; без фикса — красный (мёртвая ветка).
- [x] `bun run verify` зелёный; `stitchkit@0.53.1` на npm.

## Что сделано

- [x] `packages/core/src/browser/http.ts` — бренд `Symbol.for('stitchkit.ApiError')`, `is` по бренду, non-enumerable
- [x] `packages/core/src/contract/errors.ts` — `traceId` шестым параметром AppError (аддитивно), toJSON не тронут
- [x] `packages/core/src/tools/remote.ts` — `transformArgs` внутри try; конверсия передаёт traceId
- [x] Тесты `packages/core/tests/api-error-brand.test.ts` (7 кейсов): `recognises a foreign-chunk ApiError carrying the same brand`; `a foreign-chunk ApiError converts to AppError with code, status, hint and traceId` (репро мёртвой ветки — instanceof в тесте явно даёт false); `an ApiError thrown by transformArgs converts the same way`; `a non-ApiError from the call is rethrown untouched`; brand-не-течёт-в-JSON
- [x] CHANGELOG `[0.53.1]` Fixed; сопутствующие фичи-запросы потребителя вынесены отдельными inbox-тасками (`2026-08-18-cli-wait-failed-hook.md`, `2026-08-18-implement-remote-light-entrypoint.md`) — реализация по команде
