---
title: Сквозная корреляция browser ApiError с backend request trace
description: Сохранить x-request-id в ApiError для bare и Ky-backed HTTP-клиентов без изменения wire contract.
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 16:46 +07:00
---

# Сквозная корреляция browser ApiError с backend request trace

## Контекст

HTTP transport уже возвращает framework-owned `x-request-id`, совпадающий с
`traceId` request event и backend-логов. Оба browser client path теряют этот
идентификатор при преобразовании неуспешного `Response` в `ApiError`, поэтому
consumer вынужден сопоставлять frontend и backend ошибки по времени.

Это additive observability improvement. Wire error envelope и server response
не меняются; ошибки без полученного HTTP response не имеют request id.

## План

- [x] Расширить `ApiError` optional readonly полем `traceId?: string`.
- [x] Добавить один непубличный extractor для `x-request-id`, принимающий
      `Response | undefined` и возвращающий `undefined`, если response/header отсутствует.
- [x] Передать trace id в обеих ветках bare `createClient`:
      распознанный error envelope и fallback `HTTP_ERROR`.
- [x] Передать trace id в обеих response-backed ветках `createHttpClient`:
      распознанный error envelope и Ky `HTTPError` fallback.
- [x] Не приписывать trace id Ky network/abort/timeout ошибкам без HTTP response;
      bare fetch errors оставить нативными, как сейчас.
- [x] Не менять response body, error envelope, server transport или CORS policy.
- [x] Обновить public API reference, client/error guide и release changelog.
- [x] Устранить найденную на релизе гонку npm propagation общей bounded-проверкой
      для обеих независимых package release-линий.

## Acceptance

- [x] Bare client: structured API error сохраняет точный `x-request-id` в
      `ApiError.traceId`.
- [x] Bare client: unstructured non-2xx response сохраняет тот же trace id.
- [x] Ky-backed client: structured API error сохраняет точный trace id.
- [x] Ky-backed client: fallback `HTTPError`/`UNKNOWN_ERROR` сохраняет trace id.
- [x] Ky-ошибка без HTTP response получает `traceId === undefined`; bare
      network-error semantics не меняются.
- [x] Поле публично типизировано как `readonly string | undefined`.
- [x] Существующие code/status/details/message/hint и event semantics не меняются.
- [x] `bun run verify` проходит полностью.
- [x] Выпущен только `stitchkit@0.43.1`: core version/changelog/tag, CI, npm и
      GitHub Release подтверждены; `create-stitchkit` не меняется.

## Конвейер 2/2

- [x] Валидатор плана 1: полнота response/error веток и отсутствие потерь данных.
- [x] Валидатор плана 2: публичный API, документация, release и regression risks.
- [x] Находки валидаторов внесены в уточнённый план.
- [x] Реализация завершена по уточнённому плану.
- [x] Валидатор реализации 1: поведенческая эквивалентность и тестовое покрытие.
- [x] Валидатор реализации 2: API cleanliness, документация и release readiness.
- [x] Все находки исправлены, финальные гейты зелёные.

## Правки валидатора-1 — error paths

- Bare multipart и regular requests уже сходятся в одном
  `throwForErrorResponse`; отдельный transport implementation не нужен.
- Regression matrix обязана покрывать четыре response-backed ветки с
  фиксированным request id и сохранить прежние error fields/events.
- Default CORS уже exposes `x-request-id`; custom `exposeHeaders: []` остаётся
  осознанной consumer policy, server/CORS в этой задаче не меняются.
- Произвольное исключение consumer `parseError` не расширяет scope задачи.

## Правки валидатора-2 — public API и release

- Существующий positional constructor сохраняется; `traceId` добавляется
  последним optional readonly параметром, без options-object migration.
- Extractor живёт во внутреннем browser-модуле и не становится новым export.
- Public docs обновляются в API reference и client/error guide; ADR не нужен.
- Изменение классифицировано как patch bugfix: выпускается только core 0.43.1,
  с проверкой tag-driven CI, npm package и GitHub Release.

## Что сделано

- [x] **Browser API:** `packages/core/src/browser/http.ts` расширяет публичный
      `ApiError` readonly-полем `traceId`; `packages/core/src/browser/request-id.ts`
      централизованно читает framework-owned `x-request-id`.
- [x] **Bare и Ky clients:** `packages/core/src/browser/client.ts` и
      `packages/core/src/browser/http.ts` сохраняют correlation id во всех четырёх
      response-backed error branches и оставляют его пустым без HTTP response.
- [x] **Regression coverage:** `packages/core/tests/api-error-trace.test.ts`
      проверяет structured/fallback ветки обоих клиентов и network semantics;
      packed consumer fixture подтверждает public readonly type surface.
- [x] **Документация:** обновлены `docs/api/reference.md`, `docs/guide/client.md`,
      `docs/guide/auth-and-errors.md`, `docs/guide/observability.md` и `CHANGELOG.md`.
- [x] **Release reliability:** `.github/workflows/ci.yml` использует общий
      `scripts/wait-for-npm-publication.ts` с exact manifest validation, bounded
      retry и поддержкой transient HTTP/network failures для обоих пакетов.
- [x] **Гейты:** `bun run verify` зелёный; два плановых и два реализационных
      валидатора завершили аудит без оставшихся findings.
- [x] **Релиз:** tag `v0.43.1`, npm `stitchkit@0.43.1` и GitHub Release подтверждены;
      версия и release-линия `create-stitchkit` не изменялись.
- [x] **Не делалось:** wire error envelope, server transport, CORS policy и
      response body не менялись.
