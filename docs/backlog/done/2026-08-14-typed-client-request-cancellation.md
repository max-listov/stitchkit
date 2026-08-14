---
title: Per-call cancellation в typed HTTP client
description: Добавить AbortSignal как единые request options для bare и Ky-backed contract clients и отличать caller abort от timeout и network failure
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 07:21 +00:00
---

# Per-call cancellation в typed HTTP client

## Зачем

Contract endpoint может объявить статический timeout, но вызывающий код не может отменить
конкретный typed client call при закрытии страницы, смене выбора или нажатии Cancel. Для
upload consumer вынужден обходить typed client ручным `fetch`. Внутренний `RequestOptions`
также не принимает `signal`, поэтому gap существует и в bare `createClient`, и в
`createHttpClient` path.

Настоящий browser upload progress поверх Fetch/Ky недоступен. Нельзя обещать callback,
который на одном transport работает, а на другом является фикцией. Эта задача добавляет
только честную transport-neutral cancellation.

## Результат

- Каждая HTTP endpoint function принимает optional per-call `ClientRequestOptions`.
- Caller `AbortSignal` и contract/client timeout работают одновременно; срабатывает первая
  причина без утечки timers/listeners.
- Caller cancellation, timeout и network/server failures различимы через `ApiError`.
- Одинаковая семантика действует для JSON, query, multipart и raw-response endpoints в обоих
  client implementations.

## Публичный API

```ts
const controller = new AbortController();

await api.lessons.uploadFile(
  { lessonId, blockId, file },
  { signal: controller.signal },
);

controller.abort();
```

Endpoints с аргументами получают `(args, options?)`; endpoints без аргументов —
`(options?)`. `ClientRequestOptions` пока содержит только `signal`, чтобы internal
transport options (`responseType`, query planning, retry) не протекали в contract API.

Нормализация client-only failures:

- caller signal → `ApiError.code === 'REQUEST_ABORTED'`, status `0`;
- contract/client timeout → `ApiError.code === 'REQUEST_TIMEOUT'`, status `0`;
- прочая transport failure → существующий `UNKNOWN_ERROR` и `network_error` event.

Abort/timeout не эмитят `network_error` и не ретраятся.

## План

- [x] Добавить public `ClientRequestOptions` и расширить `EndpointFn` inference для
      endpoint с args и без них.
- [x] Пронести signal через request planner в bare fetch и `HttpClient.RequestOptions`.
- [x] Собрать caller signal и endpoint/client timeout одним helper на базе Web Abort APIs;
      cleanup listeners/timers обязателен после settlement.
- [x] Нормализовать abort reason одинаково для Fetch и Ky, включая already-aborted signal.
- [x] Не эмитить `network_error` и не выполнять retry на caller abort/timeout.
- [x] Проверить, что raw `Response` и multipart paths не обходят общий helper.
- [x] Обновить client guide, API reference, examples и generated LLM docs.
- [x] Добавить additive changelog entry; breaking migration не требуется.

## Тестовая матрица

- [x] Caller отменяет pending GET, JSON POST, multipart upload и raw download.
- [x] Already-aborted signal не отправляет request.
- [x] Endpoint timeout без caller signal даёт `REQUEST_TIMEOUT`.
- [x] Caller abort выигрывает у timeout и наоборот; код соответствует первой причине.
- [x] Успешный call с двумя signals не оставляет event listeners/timers.
- [x] Bare fetch и Ky-backed path дают одинаковый `ApiError` shape.
- [x] Abort и timeout не эмитят `network_error`, HTTP error продолжает содержать traceId.
- [x] Type tests покрывают endpoint functions с аргументами и без них.

## Acceptance

- [x] Любой typed HTTP call можно отменить без перехода на manual fetch.
- [x] Contract timeout продолжает работать и не перезаписывает caller cancellation.
- [x] Три класса failure — abort, timeout, network/server — программно различимы.
- [x] API одинаков на Web, Bun и React Native runtimes, использующих AbortSignal.
- [x] В API не появляется `onUploadProgress` до появления честного общего transport.
- [x] Полный `bun run verify` зелёный.

## Не входит

- Upload/download progress callbacks.
- Resumable upload и automatic retry non-idempotent requests.
- TanStack Query cancellation adapters: consumer передаёт предоставленный signal напрямую.

## Что сделано

- [x] **Public API:** `packages/core/src/contract/define.ts` и
      `packages/core/src/browser/client.ts` добавляют `ClientRequestOptions.signal` для
      endpoint functions с аргументами и без них.
- [x] **Cancellation engine:** `packages/core/src/browser/cancellation.ts`, `http.ts` и
      `client-multipart.ts` объединяют caller signal и timeout, освобождают listeners/timers
      и различают `REQUEST_ABORTED` и `REQUEST_TIMEOUT` в bare/Ky paths.
- [x] **Семантика ошибок:** caller abort/timeout не маскируются как network error и не
      запускают retry; HTTP errors сохраняют прежнюю нормализацию и trace ID.
- [x] **Тесты:** `packages/core/tests/client-cancellation.test.ts` —
      `caller abort cancels GET, JSON, multipart and raw-response calls`,
      `an already-aborted signal never sends the request`,
      `endpoint timeout is distinct from caller cancellation`,
      `abort and timeout do not emit Ky network_error events`,
      `the first cancellation cause wins the caller/timeout race`.
- [x] **Гейты:** полный `bun run verify` прошёл, включая typecheck и Node smoke.
