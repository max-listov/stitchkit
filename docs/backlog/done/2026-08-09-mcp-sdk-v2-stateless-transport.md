---
title: "MCP SDK v2 — stateless HTTP/stdio transport cutover"
description: "Перевести MCP runtime на split packages и официальные v2 serving entrypoints, удалить stateful session/event layer и мигрировать публичные SDK-типы."
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 16:14 +00:00
related: docs/backlog/done/2026-08-09-mcp-2026-v2-release.md
---

# MCP SDK v2 — stateless transport cutover

## Зачем

Текущий `createMcpHandler` вручную подключает v1
`WebStandardStreamableHTTPServerTransport`; `createStdioMcpServer` вручную
подключает `StdioServerTransport`. Даже после замены package на v2 такой код по
умолчанию продолжит обслуживать 2025-era handshake. Modern protocol включается
только официальными `createMcpHandler(factory)` и `serveStdio(factory)`.

Одновременно Stitchkit публично экспортирует v1 `McpServer`, принимает его в
`rawTools`/mount helpers и содержит полностью лишний stateful branch. Это один
breaking transport/API cutover.

## Как сейчас

- `packages/core/src/tools/mcp-handler.ts`: stateless default плюс explicit
  `sessionMode: 'stateful'`, `InMemoryEventStore`, sessions map, TTL/LRU/sweep.
- `packages/core/src/tools/mcp-stdio.ts`: `server.connect(new StdioServerTransport())`.
- `packages/core/src/tools/mcp.ts`, `tools.ts`, `toolkit.ts`, upload/download/wait/
  view-file helpers и tests импортируют v1 `McpServer`.
- `packages/core/package.json`: optional peer/dev dependency на монолитный SDK.

## Результат

- `@modelcontextprotocol/server@2` становится единственным direct MCP server SDK.
- Stitchkit HTTP handler использует официальный modern-aware Web handler.
- Один route обслуживает modern `2026-07-28` и официальный legacy-stateless path;
  никакого собственного negotiation layer.
- Stdio запускается через `serveStdio` и действительно говорит на modern wire.
- Весь framework-owned tool runner и prepared surface остаются transport-neutral.
- Public types и raw escape hatch используют v2 `McpServer` без aliases.
- `createMcpHandler()` возвращает framework-owned `McpHttpHandler` с
  `fetch(request)` и `close()`; `createMcpHttpRoute()` монтирует `fetch`, а
  shutdown приложения вызывает `close`.
- `createStdioMcpServer()` возвращает `McpStdioHandle` с `close()`, совпадающий
  по lifecycle с официальным `StdioServerHandle`, но не экспортирующий transport.
- HTTP разрешает auth ровно один раз до SDK factory и передаёт тот же immutable
  auth snapshot в discovery, registration и execution данного запроса.

## Целевая публичная форма

```ts
export interface McpHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface McpStdioHandle {
  close(): Promise<void>;
}

const mcp = createMcpHandler({
  services,
  serverInfo,
  legacy: 'serve',
});

const route = createMcpHttpRoute({ path: '/mcp', handler: mcp });
await mcp.close();
```

Для HTTP `legacy: 'serve'` отображается на официальный stateless fallback;
`legacy: 'reject'` делает endpoint modern-only. Другого mode нет: `stateful`,
raw transport и SDK `notify`/`bus` наружу не выдаются.

## План

- [x] Заменить optional peer монолитного SDK на
      `@modelcontextprotocol/server@^2`; client package использовать только как
      dev dependency для E2E. Не-MCP consumer обязан устанавливать Stitchkit без
      MCP peer; MCP consumer получает понятную peer diagnostic. Не добавлять
      `@modelcontextprotocol/node`, если Web-standard entrypoint закрывает API.
- [x] Прогнать официальный codemod только как механический первый проход и вручную
      проверить каждый public import/export и generated declaration.
- [x] Сохранить transport-neutral `buildMcpServer`/`buildMcpServerFromPrepared`, но
      вернуть v2 `McpServer` и адаптировать changed registration signatures.
- [x] Построить внутреннюю per-request server factory: auth разрешается на каждый
      HTTP request, finite/static prepared descriptors переиспользуются, свежие
      server/context/handlers создаются на вызов.
- [x] Обернуть factory официальным SDK HTTP handler с `legacy: 'stateless'`;
      modern protocol и legacy stateless работают на одном route. Unauthorized
      discovery/call не должен ошибочно переходить в legacy branch.
- [x] Ввести `McpHttpHandler = { fetch(request): Promise<Response>; close():
      Promise<void> }`; не протаскивать наружу SDK `notify`/`bus`. `close()`
      прекращает приём новых вызовов, отменяет in-flight modern streams/calls и
      идемпотентно освобождает все instance/transport resources.
- [x] Обновить `createMcpHttpRoute` и toolkit facade под `handler.fetch`; route
      wrapper сохраняет framework auth/error headers и не дублирует negotiation.
- [x] Сохранить RFC 9728 `401 WWW-Authenticate` до передачи запроса SDK и убедиться,
      что unauthorized ответ корректен для обоих eras.
- [x] Полностью удалить `McpSessionMode`, `sessionMode`, `SessionData`,
      `InMemoryEventStore`, event/session caps, sweep interval и ручную обработку
      `Mcp-Session-Id`/GET SSE resume.
- [x] Перевести stdio entrypoint на `serveStdio(() => freshServer, {
      legacy: 'serve' })`; вернуть framework `McpStdioHandle { close }`, сохранить
      one-time auth resolution на connection и stderr-only logging contract.
- [x] Добавить единую optional compatibility policy `legacy: 'serve' | 'reject'`:
      для HTTP `'serve'` отображается на SDK `'stateless'`, для stdio — на
      `'serve'`; отдельного stateful compatibility API нет.
- [x] Мигрировать `rawTools`, `mountMcpResource`, upload/download/wait/view-file,
      toolkit facade и `stitchkit/tools` export на v2 type.
- [x] Удалить v1 session tests; заменить их modern HTTP negotiation, stateless
      parallel calls, restart independence и legacy-stateless fallback tests.
- [x] Перевести in-memory v1 tests на поддерживаемый v2 test path: modern tests
      вызывают Web handler через client transport/custom fetch, а pure runner tests
      остаются transport-neutral.
- [x] Stdio E2E запускать отдельным child process через официальный client
      transport: modern и legacy opening, stdout содержит только JSON-RPC,
      diagnostics идут в stderr, `close()` завершает process resources.
- [x] Зафиксировать transport security policy: запрос без `Origin` разрешён для
      non-browser MCP client; присутствующий `Origin` должен пройти explicit
      allowlist/same-origin policy; `Host`/request URL валидируются до SDK.
      Добавить hostile Origin/Host tests без Node leakage в Fetch-clean core.
- [x] Добавить negative wire matrix: неверный content type, malformed JSON,
      protocol-version mismatch, aborted request, cancellation during handler,
      duplicate `close()` и вызов после close.
- [x] Проверить параллельные calls с разными identities: context/auth/hooks не
      пересекаются и prepared descriptors не захватывают request state.
- [x] Обновить architecture MCP transport, guide, API reference, README examples,
      llms source и CHANGELOG breaking section.

## Breaking migration

- `createMcpHandler(config)` больше не является callable function:
  `await handler(request)` → `await handler.fetch(request)`; при lifecycle
  shutdown вызывается `await handler.close()`.
- `createStdioMcpServer(config)` больше не возвращает raw `McpServer`; он
  возвращает closeable `McpStdioHandle` и сам владеет serving transport.
- Удаляется `sessionMode`; consumer удаляет поле, а state переносит в явные
  domain handles/MRTR.
- Экспорт `McpServer` и callback `rawTools` получают v2 type/import lineage.
- Consumer, который импортировал v1 SDK для raw registration, переходит на
  `@modelcontextprotocol/server` либо на framework `runtimeTools`.
- Ручное использование `Mcp-Session-Id`, initialize lifecycle или SSE resume
  больше не поддерживается Stitchkit handler.

## Acceptance

- [x] `rg '@modelcontextprotocol/sdk|Mcp-Session-Id|sessionMode|InMemoryEventStore'`
      по `packages/core/src` не находит runtime/public leftovers.
- [x] Modern client pinned to `2026-07-28` выполняет list + contract tool + runtime
      tool через HTTP без initialize/session id.
- [x] Auto-negotiating client и legacy-stateless client работают на том же handler.
- [x] Два параллельных identity calls получают разные context/auth и корректные hooks.
- [x] Новый handler переживает restart/новый instance без continuity state.
- [x] Stdio modern round-trip проходит через публичный entrypoint.
- [x] Legacy stdio работает через официальный `legacy: 'serve'`; modern-only
      policy `reject` отказоустойчива и документирована.
- [x] `close()` aborts in-flight work, чистит transport resources и идемпотентен.
- [x] Hostile Origin/Host, malformed content, era mismatch и cancellation
      покрыты negative E2E; transport reject не создаёт successful tool audit.
- [x] Packed Bun и Node consumers компилируют публичные v2 declarations.
- [x] Package без MCP peer импортирует browser/HTTP/React surfaces; MCP import без
      server peer падает понятной installation diagnostic.
- [x] Browser-clean gate не обнаруживает server/Node imports в browser entrypoints.

## Конвейер 2/2 со стопом

- [x] Валидатор плана 1: v2 transport/era negotiation и stateless correctness.
- [x] Валидатор плана 2: public types, prepared surfaces и consumer breakage.
- [x] Findings внесены; ожидается owner stop-gate перед кодом.
- [x] Валидатор реализации 1: modern/legacy wire E2E и concurrency.
- [x] Валидатор реализации 2: API/d.ts/Fetch-clean/deletion audit.

## Правки валидатора 1

- Выбраны точные HTTP/stdio lifecycle handles и era defaults; hand-built
  `McpServer` больше не считается modern serving entrypoint.
- Добавлены auth-once, cancellation/close, malformed wire, Origin/Host и
  stdio-child-process gates.
- `subscriptions/listen`, session resume и unsolicited push явно не заявляются.

## Правки валидатора 2

- Зафиксирована breaking callable→`{ fetch, close }` миграция и изменение stdio
  return type с raw server на owned handle.
- Уточнены optional peer/dev dependencies и packed non-MCP/MCP fixtures.
- `createMcpHttpRoute`, toolkit, raw tools и emitted `.d.ts` включены в один
  public-surface audit без compatibility wrapper.

## Что сделано

- [x] Split peers `@modelcontextprotocol/server`/`client` заменили монолитный SDK
      в `packages/core/package.json`, fixtures и `bun.lock`.
- [x] HTTP ownership оформлен как `McpHttpHandler { fetch, close }`, а
      `createMcpHttpRoute` делегирует transport без raw consumer wrapper.
- [x] Stdio использует официальный v2 serving entrypoint и owned close handle.
- [x] Stateful session types, event store, resume и `Mcp-Session-Id` удалены из
      runtime; modern/legacy era policy остаётся одной явной настройкой.
- [x] Wire, auth isolation, cancellation, concurrency, Bun/Node packed consumers
      и child-process stdio проверены в `packages/core/tests/mcp-*.test.ts` и
      `packages/core/scripts/consumer-lane/`.
- [x] Public guide/reference и architecture обновлены без compatibility aliases.
