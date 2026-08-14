---
title: Надёжно распознавать сетевые ошибки Bun в HTTP retry
description: Исправить transport retry createHttpClient, чтобы безопасные GET переживали Bun ConnectionRefused без consumer-specific обходов.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 21:17 +07:00
---

# Надёжно распознавать сетевые ошибки Bun в HTTP retry

## Зачем

Один consuming project обнаружил разрыв между публичной семантикой Stitchkit и
фактическим поведением `createHttpClient` под Bun. Клиент настроил идемпотентный
SSR `GET` с `retry.limit: 5`, чтобы пережить измеренное окно переподключения
backend во время immutable release cutover. В этом окне старый frontend ещё
обслуживал авторизованный запрос, а backend временно не принимал TCP-соединения.

Stitchkit документирует transport retry как повтор сетевой ошибки на разрешённых
методах, однако реальный запрос к закрытому порту завершился примерно за 7 ms с
`ApiError(UNKNOWN_ERROR)` и не выполнил ни одного повтора. Валидная cookie из-за
этого могла временно интерпретироваться приложением как отсутствие сессии.
Consumer-side `shouldRetry`, wrapper или строковая проверка сообщения были бы
неправильны: runtime portability HTTP transport принадлежит Stitchkit.

Это generic-дефект. Он проявился в проекте с прямым SSR-вызовом внутреннего Bun
backend, измеримым окном `delete/start` и непрерывным авторизованным observer.
Другие consumers могут не иметь SSR internal client, использовать более короткий
reload или просто ещё не попасть запросом в окно недоступности; это не делает их
защищёнными от той же ошибки при реальном `ConnectionRefused`.

## Подтверждённые факты

- Stitchkit `0.48.0` передаёт Ky только `limit`, `methods` и `statusCodes`.
- Текущий default обещает network-only retry для `GET`.
- Ky `2.0.2` распознаёт raw network errors runtime-specific эвристикой:
  проверяет `TypeError` и известные сообщения.
- Bun `1.3.14` на запрос к закрытому локальному порту выбрасывает обычный
  `Error`, поэтому Ky не создаёт `NetworkError` и немедленно завершает retry.
- Ошибка Bun имеет структурированные own properties и не требует message parsing:

  ```text
  name: Error
  code: ConnectionRefused
  errno: 0
  path: http://127.0.0.1:<closed-port>/...
  message: Unable to connect. Is the computer able to access the url?
  ```

- Ky вызывает `retry.shouldRetry` только после проверки `retry.limit` и
  разрешённого HTTP method. `true` принудительно подтверждает retry,
  `undefined` оставляет стандартную Ky-классификацию без изменений.
- В документации Stitchkit `retry.limit` сейчас назван количеством attempts,
  хотя Ky трактует его как число retries. Default `limit: 2` допускает до трёх
  общих попыток.

## Корневое решение

Stitchkit должен владеть узким runtime adapter для структурированных Bun network
errors и подключать его к внутреннему Ky retry decision. Публично экспортировать
сырой Ky `shouldRetry` не нужно: это протечка реализации и приглашение каждому
consumer повторять одинаковую runtime-классификацию.

Classifier обязан:

- сначала исключать `ApiError`, Ky `HTTPError` / `NetworkError` /
  `TimeoutError`, cancellation/abort и любые ошибки с HTTP-response semantics;
- только для оставшейся plain runtime fetch error читать структурированный
  `error.code`, не английское сообщение;
- распознавать только доказанный в этой задаче transport-код Bun
  `ConnectionRefused` через exact allowlist;
- возвращать `true` только для известных Bun network errors;
- возвращать `undefined` для Ky `NetworkError`, HTTP errors, timeout,
  cancellation и неизвестных исключений, сохраняя штатное поведение Ky;
- не обходить Ky method и limit checks;
- не расширять default retry на `POST` и другие мутации.

## Результат

- `createHttpClient` выполняет заявленный retry реального Bun
  `ConnectionRefused` для разрешённого идемпотентного метода.
- Временно отсутствующий backend может появиться внутри retry budget, после чего
  исходный typed client call успешно завершается без consumer workaround.
- Исчерпанный budget остаётся наблюдаемой `ApiError`; длительная авария не
  маскируется.
- `POST`, `401`, caller abort и timeout не получают новых повторов.
- Node и browser сохраняют штатную Ky network classification.
- Документация точно различает retries и total attempts.

## План

- [x] Добавить внутренний Web/Bun-safe type guard для структурированного
      `error.code` без type assertions и без импорта Bun-типов в browser surface.
- [x] До проверки Bun-кода fail-closed исключить `ApiError`, Ky HTTP/network/
      timeout errors и cancellation semantics, чтобы совпадающий доменный
      error code не мог превратить HTTP response в transport retry.
- [x] Зафиксировать минимальный explicit allowlist доказанных retryable Bun
      transport codes, содержащий только `ConnectionRefused`; не использовать
      prefix matching и message regex.
- [x] Подключить classifier к `retry.shouldRetry` внутри `createHttpClient`:
      известная Bun network error → `true`, всё остальное → `undefined`.
- [x] Сохранить единственный существующий public `HttpClientConfig.retry` без
      Ky callbacks, compatibility API и второго transport path.
- [x] Добавить реальный Bun integration regression в изолированном subprocess:
      обёртка над native `fetch` считает вызовы; первый вызов обязан реально
      завершиться plain `Error` с `code: ConnectionRefused`; только после этого
      запускается backend на том же порту, и исходный `GET` завершается второй
      native попыткой. Cleanup и общий bounded timeout обязательны.
- [x] Добавить exhausted-budget regression с точным счётчиком: `limit: 2` даёт
      три native attempts, один финальный `network_error` и
      `ApiError(UNKNOWN_ERROR, status: 0)`; `limit: 0` даёт одну попытку.
- [x] Добавить negative regression: при default `methods: ['get']` POST на Bun
      `ConnectionRefused` не повторяется даже при ненулевом limit; явно
      настроенные consumer methods остаются существующей политикой Ky. Счётчик
      обязан показать ровно одну native attempt.
- [x] Добавить responding-server regression: structured `401` с envelope code
      `ConnectionRefused` выполняется один раз, сохраняет исходный `ApiError` и
      не классифицируется как network failure.
- [x] Доказать, что caller abort и request timeout не проходят через Bun
      network classifier при ненулевом/default limit: already-aborted = 0
      attempts, in-flight abort = 1, timeout hanging server = 1;
      `REQUEST_ABORTED`/`REQUEST_TIMEOUT`, `network_error` = 0.
- [x] Проверить coexistence с project-configured `statusCodes` на
      **unstructured** `503`, который Ky представляет как `HTTPError`:
      первый ответ `503`, второй `200`, `limit: 1` и ровно два server calls;
      classifier возвращает `undefined`, существующий Ky retry не меняется.
      Structured error-envelope/statusCodes integration в эту задачу не входит.
- [x] Добавить private classifier unit matrix: Ky `NetworkError`, `HTTPError`,
      timeout/abort, `ApiError`, unknown code и accessor/inherited code не
      подтверждают Bun retry; exact own `ConnectionRefused` подтверждает.
- [x] Добавить реальный Node smoke для `createHttpClient`: closed port →
      подтверждённая первая ошибка → late server → успешная повторная попытка с
      точным attempt count.
- [x] Зафиксировать неизменность public surface: classifier не экспортируется,
      `HttpClientConfig` не получает Ky callback, public-surface fixture не
      меняется.
- [x] Исправить `HttpClientConfig` comment, client guide, API reference и
      changelog: `limit` — количество повторов; default `2` = максимум три
      попытки.
- [x] Регенерировать agent-facing docs штатным build pipeline, не редактировать
      `llms.txt`/`llms-full.txt` вручную.
- [x] Прогнать `bun run verify`, включая Node smoke и packed consumer lane.

## Тестовая матрица

| Сценарий | Метод | Ожидание |
|---|---|---|
| Closed port, backend появляется внутри budget | GET | вызов успешно завершается после retry |
| Closed port, backend не появляется, `limit: 2` | GET | 3 attempts, один `network_error`, финальный `ApiError` |
| Closed port, `limit: 0` | GET | 1 attempt, финальный `ApiError` |
| Closed port, default methods | POST | 1 attempt, без автоматического replay |
| Structured `401`, envelope code `ConnectionRefused` | GET | 1 response; исходный `ApiError`; unauthorized = 1; network_error = 0 |
| Configured unstructured `503` → `200`, `limit: 1` | GET | 2 calls; штатный `statusCodes` retry |
| Caller signal already aborted | GET | 0 attempts; `REQUEST_ABORTED`; network_error = 0 |
| Caller signal aborted in-flight | GET | 1 attempt; `REQUEST_ABORTED`; network_error = 0 |
| Request timeout on hanging server | GET | 1 attempt; `REQUEST_TIMEOUT`; network_error = 0 |
| Node/browser-recognized network error | GET | штатная Ky классификация сохраняется |

## Acceptance

- [x] Реальный Bun `Error` с `code: 'ConnectionRefused'` повторяется на GET в
      пределах `retry.limit`.
- [x] Integration test доказывает сценарий «порт закрыт → backend появился →
      первоначальный вызов успешен» без mock-only classifier, тайминговой гонки
      и TOCTOU-доказательства; attempt count = 2.
- [x] Исчерпанный budget fail-loud и не превращается в успешный/пустой результат.
- [x] POST и другие неразрешённые methods не повторяются.
- [x] HTTP `401`, abort и timeout не ошибочно классифицируются как Bun network
      errors.
- [x] Доменный `ApiError.code === 'ConnectionRefused'` не подтверждает retry.
- [x] Не добавлены consumer callbacks, wrapper API, aliases или message matching.
- [x] Нет нового public export; shape `HttpClientConfig` и public-surface fixture
      не меняются.
- [x] Public docs точно описывают retry count и default maximum attempts.
- [x] Документация единообразно говорит: `limit` — число retries после первой
      попытки; default `2` = максимум три total attempts; default method GET;
      `statusCodes: []`; explicit `methods`/`statusCodes` расширяют policy.
- [x] Версии пакетов, version-related `bun.lock`, `create-stitchkit`, starter
      template и catalog не меняются; commit/tag/publish не выполняются.
- [x] Core tests, typecheck, lint, build, Node smoke и consumer lane зелёные.

## Не входит

- Изменение release/reconcile механики consuming project.
- Blue-green deployment или process orchestration внутри Stitchkit.
- Retry бизнесовых мутаций.
- Бесконечный retry или подавление окончательной ошибки.
- Consumer-specific SSR policy и выбор его retry budget.
- Публичный Ky `shouldRetry` escape hatch.
- Релиз, commit, push или downstream dependency update в рамках реализации этой
  задачи без отдельной команды владельца.

## Конвейер 2/2

- [x] Валидатор плана 1: runtime semantics, Bun/Ky boundary, retry safety —
      добавлено fail-closed исключение HTTP/cancellation ошибок; уточнены
      structured envelope, `statusCodes` и method-policy границы.
- [x] Валидатор плана 2: тестовая доказательность, public API и документация —
      исключены timing-only тесты; добавлены exact counters, Node smoke,
      private classifier matrix и release-purity assertions.
- [x] Замечания обоих валидаторов внесены до начала реализации.
- [x] Валидатор реализации 1: runtime equivalence и negative cases — PASS.
- [x] Валидатор реализации 2: public surface, docs, release purity и gates —
      PASS после устранения race в Node late-server smoke.

## Правки валидатора плана 1

- Совпадение `ApiError.code` с Bun transport code признано небезопасным
  критерием: classifier обязан сначала доказать отсутствие HTTP response
  semantics и только затем читать runtime `error.code`.
- Negative test усилен structured `401` с намеренно конфликтующим code.
- Проверка `statusCodes` ограничена unstructured `503`: structured Stitchkit
  envelope сейчас преобразуется в `ApiError` внутри `afterResponse` и является
  отдельной существующей семантикой, которую эта задача не меняет.
- POST-ожидание привязано к default method policy. Публичный `retry.methods`
  остаётся каноническим способом явно разрешить другой идемпотентный метод.

## Правки валидатора плана 2

- Late-server regression переведён на изолированный subprocess и handshake с
  реальным первым native fetch failure; тест больше не может случайно попасть
  сразу в уже поднятый server и ложно пройти без retry.
- Для budget, POST, abort, timeout, `401` и `503` закреплены точные attempt/event
  counters, а не только конечный результат.
- Существующие cancellation tests с `limit: 0` признаны недостаточным
  доказательством для новой classifier-ветки; добавлена отдельная матрица с
  ненулевым/default limit.
- Node parity получает настоящий HTTP smoke, browser portability — private unit
  matrix и существующий browser-clean build gate.
- Public API и release purity закреплены негативно: ни нового export, ни Ky
  callback, ни version/starter/release mutation.

## Правки валидатора реализации 1

- Подтверждено, что classifier читает только own data-property с exact code и
  заранее исключает HTTP, domain, Ky network/timeout и cancellation errors.
- Подтверждено сохранение Ky method/limit gates и полное покрытие реальным Bun
  subprocess: late server, budget, POST, abort, timeout, `401` и `503`.
- Node parity подтверждена настоящим closed-port → late-server round trip с
  двумя native fetch attempts.

## Правки валидатора реализации 2

- Найдена потенциальная timing race в первой версии Node smoke: вторая попытка
  могла начаться до перехода late server в listening state.
- Добавлен promise barrier: первая реальная Node network error возвращается Ky
  только после успешного `listen`; listen failure отклоняет тот же barrier.
- Ожидание итогового retry ограничено 10-секундным deadline, exact attempt count
  остаётся равен двум. Повторная валидация дала PASS.
- Подтверждены неизменность package public surface и `HttpClientConfig`,
  Fetch-clean browser boundary, единообразные docs и отсутствие release mutation.

## Что сделано

- [x] **Browser transport:** в
      `packages/core/src/browser/http.ts` добавлен узкий внутренний classifier
      Bun `ConnectionRefused` и подключён к единственному Ky retry pipeline без
      нового публичного API.
- [x] **Bun regression:**
      `packages/core/tests/http-retry.test.ts` — тест
      `Bun HTTP retry preserves method, budget, cancellation and response semantics`
      запускает изолированный fixture
      `packages/core/tests/fixtures/http-retry-probe.ts` и проверяет exact
      attempts/events для всей transport-матрицы.
- [x] **Classifier regression:**
      `packages/core/tests/http-retry.test.ts` — тест
      `Bun classifier is exact, own-property-only and leaves Ky semantics untouched`
      проверяет positive own code и negative Ky/HTTP/domain/timeout/abort/
      inherited/accessor cases.
- [x] **Node parity:** `packages/core/scripts/node-smoke.mjs` выполняет реальный
      closed-port → late-server retry с barrier, bounded deadline и двумя native
      fetch attempts; smoke сообщает `Node network retry round-trip: OK`.
- [x] **Документация:** обновлены `docs/guide/client.md`,
      `docs/api/reference.md`, JSDoc `HttpClientConfig` и `[Unreleased] / Fixed`
      в `CHANGELOG.md`; build штатно регенерировал agent-facing docs.
- [x] **Гейты:** два валидатора реализации дали PASS; финальный
      `bun run verify` прошёл lint, typecheck, tests, build, Node smoke,
      consumer lane и оба packed starter lane.
- [x] **Не выполнялось:** версии, starter/template/catalog и public surface этой
      задачей не менялись; commit, push, tag, publish и downstream rollout не
      выполнялись.
