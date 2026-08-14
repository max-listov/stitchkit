---
title: In-process integration client для HTTP handler
description: Тестировать настоящий generated client и handler через Web Fetch без временного TCP-сервера.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 13:47 +00:00
---

# In-process handler test client

## Зачем

Интеграционный тест цепочки `contract → generated client → handler → hooks →
service` сейчас требует временного `Bun.serve()` на случайном порту. Это проверяет
реальный путь, но добавляет TCP lifecycle, занятые порты и runtime-specific setup
туда, где обе стороны уже используют стандартные Web `Request` / `Response`.

## Результат

Официальный test helper создаёт полностью типизированный client поверх настоящего
Stitchkit handler и вызывает его in-process. Он использует тот же request planner,
multipart encoder, error parser и output validation, что production clients;
единственная замена — доставка `Request` непосредственно в handler вместо TCP.

Предварительная форма API:

```ts
const api = createHandlerTestClient({
  contract,
  handler,
  pathPrefix: 'api',
})
```

Для registry должен быть один batch-вариант, производный от той же реализации, а
не отдельная тестовая модель клиента.

## План

- [x] Выделена минимальная Fetch transport boundary, через которую
  production bare client и test helper используют один request/error pipeline.
- [x] Реализованы single-contract helper и типизированный registry-вариант без
  открытия TCP socket.
- [x] Абсолютный synthetic origin используется только для построения валидного
  `Request`; наружу он не должен влиять на route semantics.
- [x] Сохранены headers, cookies, query, params, multipart, raw responses,
  cancellation, `ApiError`, `traceId` и output validation.
- [x] Проверены реальные lifecycle/hooks/authorization handler без mock-подмен
  внутри helper.
- [x] API размещён в явном `stitchkit/testing` entrypoint, поэтому test-only
  surface не раздувает browser production bundle.
- [x] Добавлен parity test: одинаковый сценарий через in-process helper и
  временный HTTP server возвращает одинаковый observable результат.
- [x] Обновлены testing guide, API reference, changelog и generated llms docs.

## Не входит

- Mock service engine, обход handler или прямой вызов endpoint function.
- Эмуляция особенностей конкретного TCP proxy, nginx, CORS или реальной сети.
- Встроенный test runner и assertion library.

## Acceptance

- [x] Helper не открывает порт и не зависит от `Bun.serve()`.
- [x] Generated method types полностью совпадают с `createClient()` для того же
  contract, включая `.withOptions()` и scoped arguments.
- [x] Успешные JSON, void, nullable, raw response и multipart операции проходят
  через настоящий handler.
- [x] Ошибки сохраняют status, code, details, headers и `x-request-id → traceId`.
- [x] Cookies и custom headers наблюдаемы обеими сторонами без специального обхода.
- [x] Реализация не содержит второго request planner или error decoder.
- [x] Node-compatible Fetch path и Bun test path зелёные в `bun run verify`.

## Что сделано

- [x] **Client boundary:** `packages/core/src/browser/client.ts` принимает
  типизированный `ClientFetch`, сохраняя единый planner, encoder и error decoder
  для network и in-process транспорта.
- [x] **Testing API:** `packages/core/src/testing.ts` реализует
  `createHandlerTestClient()` и `createHandlerTestClients()`; entrypoint объявлен
  в `packages/core/package.json`.
- [x] **Tests:** `packages/core/tests/handler-test-client.test.ts` покрывает JSON,
  nullable, void, headers/cookies, `ApiError.traceId`, raw response, multipart,
  cancellation, scoped/batch clients, `runs authorization and lifecycle hooks
  through the real handler` и `matches the observable result of a real HTTP
  server`.
- [x] **Runtime compatibility:** `packages/core/scripts/node-smoke.mjs` и
  `packages/core/scripts/consumer-lane/fixtures/minimal/src/app.ts` вызывают
  public helper через реальный handler.
- [x] **Public surface:** обновлены public-type и reference-coverage gates, а
  также `packages/core/tests/fixtures/public-surface.json`.
- [x] **Docs:** обновлены `docs/guide/testing-and-deployment.md`,
  `docs/guide/getting-started.md`, `docs/api/reference.md` и `CHANGELOG.md`.
- [x] **Что не делалось:** TCP/proxy/CORS эмуляция и mock service engine не
  добавлялись; release, commit, push и deploy не выполнялись.
