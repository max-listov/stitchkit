---
title: "Client-closed HTTP request is a cancellation, not a server error"
description: "Отделить подтверждённое закрытие HTTP-запроса клиентом от application failures: не создавать ложный 500/error/audit, завершать request нейтральным 499 и сохранить строгую обработку внутренних AbortError."
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21 04:31 +0000
related:
  - docs/decisions/0042-the-audit-row-may-name-the-cause.md
  - docs/backlog/done/2026-08-10-sse-client-disconnect-is-not-an-error.md
  - docs/backlog/done/2026-08-21-first-class-request-cancellation-observability.md
---

# Client-closed HTTP request is a cancellation, not a server error

## Зачем

В опубликованном `stitchkit@0.56.0` HTTP dispatcher не отличает закрытие запроса
клиентом от ошибки приложения. Типичный воспроизводимый сценарий:

1. Клиент начинает HTTP-запрос и закрывает соединение до ответа — например, при
   reload страницы во время rolling release.
2. Runtime помечает `request.signal` как aborted, а выполнявшийся handler или
   нижележащая операция завершается `DOMException` с `name: "AbortError"`.
3. `respondError` передаёт эту ошибку в общий application-error pipeline.
4. Project `onError` вызывается, `normalizeError` печатает unexpected error в
   `console.error` и превращает её в `INTERNAL_SERVER_ERROR 500`.
5. Request logger и audit observability записывают ложную server failure, из-за
   чего штатная отмена клиентом выглядит как production incident.

Есть второй framework-owned вариант того же дефекта: клиент закрывает соединение
в середине upload, `readRequestText` получает `AbortError` из `req.text()` или
`ReadableStreamDefaultReader.read()`, и ошибка попадает в тот же `respondError`
ещё до вызова application handler. Потребитель не может исправить этот путь у
себя.

Текущий путь подтверждён детерминированным runtime-пробником: сочетание
`request.signal.aborted === true` и `AbortError` даёт response `500`, один вызов
project `onError`, `level: error`, один `console.error` и request event с
`errorCode: INTERNAL_SERVER_ERROR`. Такой же `AbortError` при активном request
сейчас проходит тем же путём — и должен продолжить считаться внутренней ошибкой.
Отдельный реальный Bun-пробник подтверждает ту же пару signal/error при
физическом обрыве upload во время framework body read.

Корень находится в HTTP dispatcher, где одновременно доступны исходный
`Request` и thrown value. Общий `normalizeError` не владеет request signal и не
может безопасно принять это решение.

## State model

| `request.signal.aborted` | Thrown value | Framework outcome |
| --- | --- | --- |
| `true` | `AbortError` или exact `request.signal.reason` | `client_closed`: нейтральное завершение `499`, без application-error pipeline |
| `false` | `AbortError` | Обычная внутренняя ошибка: существующий `500 INTERNAL_SERVER_ERROR` |
| `true` | Иная ошибка, не равная `request.signal.reason` | Существующий error pipeline без изменений |
| `false` | Любая иная ошибка | Существующий error pipeline без изменений |

Классификация требует **оба** сигнала. На Bun thrown value имеет имя
`AbortError`; реальный Node/srvx abort использует runtime-specific `Error`, но
передаёт тот же object как `request.signal.reason`, поэтому точная identity тоже
является доказательством. Имя, message или error code без подтверждённого
`request.signal.aborted` недостаточны. Сообщение вроде
`The connection was closed` и код `ECONNRESET` не являются самостоятельным
контрактом и не участвуют в проверке.

## Результат

- HTTP dispatcher распознаёт закрытый клиентом request до project `onError`,
  `normalizeError` и error/audit recording.
- Framework завершает request best-effort ответом без body со статусом
  `499 Client Closed Request`.
- Access completion остаётся наблюдаемым ровно один раз, но пишется как
  `level: info`, без `errorCode` и `errorMessage`.
- Для `client_closed` не вызываются project `onError`, request error recorder и
  `console.error`; application-level `RequestEvent`/audit row по умолчанию не
  создаётся.
- Частота отмен всегда доступна в access log. Связанная задача добавляет opt-in
  structured row через `request.includeCancelled`; существующие sinks не
  получают новых событий без явного включения.
- Публичная модель расширяется только additive optional-полями
  `RequestEvent.outcome?: "cancelled"` и
  `RequestObservabilityConfig.includeCancelled?: boolean`; default semantics
  остаются прежними.
- Bun и Node/srvx дают одинаковую классификацию физически закрытого клиентом
  admitted HTTP request.
- `499` имеет одно framework-wide значение — client closed request — поэтому
  любой access completion с этим статусом, включая project-returned `499`,
  логируется как `info`.
- Внутренний `AbortError` при активном request и все прочие ошибки сохраняют
  прежнюю нормализацию, hooks, observability и response semantics.
- Реализация остаётся Web Fetch-clean и не вводит Bun types в `createHandler`.
- `499` остаётся runtime transport outcome и не добавляется в contract/OpenAPI
  responses.

## План

1. Добавить private classifier рядом с HTTP dispatcher:
   - проверить `request.signal.aborted === true`;
   - распознать error-like value с `name === "AbortError"` либо exact object
     identity `error === request.signal.reason` для Node/srvx;
   - не зависеть от `message`, error code, runtime-specific constructors или
     Bun API.
2. В `packages/core/src/server/create.ts` поставить ветку `client_closed` в самое
   начало `respondError`, до `recordFailure`, project `onError` и
   `normalizeError`.
3. Выделить внутреннее нейтральное завершение запроса:
   - вернуть bodyless `Response` со статусом `499`;
   - сохранить применимые response headers/CORS semantics;
   - записать один access completion на `info`;
   - не вызывать `setRequestError` и request observability/audit callback.
4. Закрепить единое логирование `499` в canonical logger path, чтобы встроенный
   JSON logger и пользовательский `logger` видели одинаковый `info`, а не
   статусную эвристику `4xx -> warn`. Явно покрыть project-returned `499`: это
   глобальное semantic rule, а не скрытый special case одной ветки dispatcher.
5. Сохранить существующий error path без перестановки hooks для всех остальных
   комбинаций состояния и ошибки.
6. Добавить focused regression suite в `packages/core/tests`:
   - client-aborted request + `AbortError` возвращает `499` без `500`;
   - project `onError`, request-error recorder и `console.error` не вызываются;
   - access completion единственный, `info`, без error metadata;
   - application `RequestEvent`/audit record отсутствует;
   - `AbortError` при активном signal остаётся `500`, вызывает прежние hooks и
     логируется как `error`;
   - aborted request с другой ошибкой остаётся в обычном error pipeline;
   - Node-style non-`AbortError`, совпадающий с `request.signal.reason` по
     identity, классифицируется как client disconnect;
   - обрыв во время framework body read/upload проходит в `client_closed`, даже
     если application handler ещё не был вызван;
   - project-returned `499` логируется как `info`;
   - прочая нормализованная ошибка сохраняет прежнее поведение;
   - generated OpenAPI document не получает response `499`.
7. Добавить реальный Bun regression без sleep-only синхронизации:
   - поднять ephemeral HTTP server на runtime-assigned port;
   - дождаться barrier, подтверждающего admission handler;
   - физически закрыть/отменить клиентское соединение;
   - дождаться server-side completion через bounded barrier;
   - повторить физический обрыв во время частично отправленного JSON body;
   - доказать aborted request signal и отсутствие `500`/error observability в
     обоих случаях.
8. Добавить real Node ≥22/srvx regression в существующий Node smoke:
   - запустить packed/built Node entrypoint на runtime-assigned port;
   - физически закрыть admitted request через `node:net`, используя admission и
     completion barriers вместо sleep;
   - обеспечить передачу disconnect в Fetch `Request.signal` на Node adapter,
     если текущий srvx bridge её не сохраняет;
   - доказать тот же `499/info`, отсутствие project `onError`/audit failure и
     физическое закрытие transport.
9. Обновить observability/server guide и `CHANGELOG.md` под `[Unreleased]`:
   - объяснить `499` как framework-owned client cancellation и осознанное
     отсутствие audit row в текущей бинарной модели;
   - прямо назвать, что project `onError` больше не получает подтверждённые
     client-disconnect `AbortError`;
   - явно указать, что внутренние `AbortError` не подавляются, а `499` не является
     contract/OpenAPI response.
10. Прогнать focused tests, typecheck/lint и полный `bun run verify`.
11. После отдельного разрешения на release выпустить patch `0.56.1` по штатному
    tag-driven flow. Downstream upgrades и deploys остаются consumer-owned и не
    выполняются из этой задачи.

## Acceptance

- [x] Только `request.signal.aborted === true` плюс `AbortError` или exact
      `request.signal.reason` identity классифицируется как `client_closed`;
      message/code matching отсутствует.
- [x] `client_closed` не проходит через project `onError`, `normalizeError`,
      `setRequestError`, `console.error` или application audit recorder.
- [x] Framework создаёт ровно один access completion со статусом `499`, уровнем
      `info` и без `errorCode`/`errorMessage`.
- [x] Любой project-returned `499` проходит через тот же canonical
      `levelForStatus(499) === "info"`; built-in и custom logger не расходятся.
- [x] Ответ для ещё доступного transport является bodyless `499`; невозможность
      доставить ответ уже закрытому peer не создаёт вторичную framework error.
- [x] `AbortError` при активном request signal по-прежнему даёт
      `500 INTERNAL_SERVER_ERROR`, вызывает project `onError` и логируется как
      `error`.
- [x] Aborted request с любой ошибкой, кроме `AbortError`, и все остальные
      failures сохраняют существующий error pipeline.
- [x] Synthetic regression matrix проходит на Web Fetch dispatcher без
      runtime-specific mocks.
- [x] Обрыв во время framework-owned body read не вызывает application handler,
      но классифицируется как тот же `client_closed`, а не `500`.
- [x] Реальные Bun tests физически отменяют admitted handler request и
      частичный upload, детерминированно доказывая server-side signal transition
      и нейтральную observability.
- [x] Real Node ≥22/srvx smoke физически закрывает admitted request и доказывает
      ту же классификацию, log level и отсутствие application failure row.
- [x] Default-off `RequestEvent` для cancellation и opt-in structured outcome
      задокументированы; access log сохраняет счётность в обоих режимах.
- [x] Публичные изменения additive и optional; existing sink behavior без
      `includeCancelled: true` не меняется.
- [x] Generated OpenAPI не объявляет `499`: это transport outcome, а не response
      contract endpoint.
- [x] Guide и `[Unreleased]` changelog описывают новое поведение без упоминания
      конкретных потребителей и прямо предупреждают, что подтверждённые client
      disconnects больше не доходят до project `onError`.
- [x] `bun run verify` зелёный до подготовки release commit/tag.
- [x] Release не выполнялся: текущий мандат прямо исключает commit, release и
      deploy; `[Unreleased]` состояние подготовлено для отдельного решения
      владельца.

## Не входит

- Классификация по тексту `AbortError` или suppression всех ошибок с таким
  именем.
- Изменение общего `normalizeError` без контекста HTTP request.
- Breaking изменение observability types; additive opt-in cancellation outcome
  реализован связанной задачей в том же проходе.
- Изменения realtime lifecycle или Socket.IO.
- Workaround, dependency bump, deploy или release в потребляющих проектах.

## Конвейер 0/0

- [x] План сверен с `createHandler`, request logging, request observability,
      OpenAPI и реальными Bun disconnect probes; plan validators не запускаются
      по явно выбранному конвейеру `0/0`.
- [x] Source fix и regressions реализованы.
- [x] Focused и полный release-equivalent gates зелёные.
- [x] Implementation validators не запускаются по конвейеру `0/0`.
- [x] Задача закрыта в `done` с точными файлами и test-case evidence.

## Что сделано

- [x] В `packages/core/src/server/create.ts`, `request-body.ts` и `logger.ts`
      добавлена Web Fetch-clean классификация подтверждённого client disconnect:
      `499 Client Closed Request`, `info`, без application error pipeline.
- [x] В `packages/core/src/observability/event.ts` и `audit.ts` добавлена
      default-off structured cancellation projection без error metadata.
- [x] `packages/core/tests/http-client-disconnect.test.ts` закрепляет synthetic и
      физические Bun сценарии cases `an aborted request plus AbortError bypasses
      the application error pipeline`, `a physical disconnect during an admitted
      handler completes as 499/info` и `a physical disconnect during partial JSON
      upload never reaches the handler`.
- [x] `packages/core/scripts/node-smoke.mjs` физически закрывает Node/srvx request
      и доказывает `499/info`, отсутствие `onError` и clean shutdown.
- [x] `packages/core/tests/openapi.test.ts` case `does not advertise
      transport-owned client disconnect status 499` закрепляет contract boundary.
- [x] `CHANGELOG.md`, `docs/guide/server.md`, `docs/guide/observability.md` и
      `docs/api/reference.md` актуализированы; `bun run verify` завершился с
      exit code `0`.
