---
title: Contract-owned HEAD endpoints
description: Добавить явный HEAD в contract router и typed surface, чтобы file/link-preview routes не оставались raw при готовом serveFile HEAD поведении
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 14:03 +00:00
---

# Contract-owned HEAD endpoints

## Источник

Кросс-аудит consuming application на Stitchkit 0.38.0. Два application routes
остаются raw только потому, что crawler/file serving требует `HEAD`, тогда как
`HttpMethod` допускает лишь GET/POST/PUT/PATCH/DELETE. `serveFile` уже умеет HEAD,
Range, ETag и conditional responses — разрыв находится в contract/router surface.

## Решение

Добавить явный `HEAD` как HTTP-only contract method. Не вводить `ALL` и не
подменять GET автоматическим неявным fallback: contract должен честно объявлять
поддерживаемые operations.

## План

- [x] Добавить `HEAD` в `HttpMethod` и пройти все exhaustive method maps:
      definition types, router, request parser, client planner, OpenAPI и logging.
- [x] Определить чистую endpoint форму для HEAD. Предпочтительная граница —
      HTTP-only `rawResponse`, поскольку handler обязан управлять headers/status,
      а response body по протоколу отсутствует.
- [x] Запретить request body/multipart/rawBody и tool exposure для HEAD на уровне типов.
- [x] Разрешить GET и HEAD на одном path как две разные operations без false
      duplicate/shadow warning.
- [x] Передавать исходный `Request` rawResponse handler-у, чтобы `serveFile`
      применял conditional/range headers тем же кодом.
- [x] Гарантировать пустой wire body для HEAD, даже если custom handler ошибочно
      вернул Response с body; status и headers сохранить.
- [x] Определить 404/405 и `Allow` semantics при наличии GET, HEAD либо обоих.
- [x] На клиенте дать осмысленный тип результата и не пытаться JSON-parse body.
- [x] Добавить OpenAPI operation и contract URL builder coverage.
- [x] Обновить contracts/server/client guides, API reference, llms и changelog.

## Tests

- [x] Explicit HEAD match и отдельный GET на том же path.
- [x] Named params, terminal wildcard и query parsing.
- [x] `serveFile`: 200/304/404/416, Range/If-Range/ETag headers и нулевой body.
- [x] Handler с ошибочным body не отправляет его на wire.
- [x] CORS, request logging, lifecycle, error hook и trace metadata совпадают с GET — HEAD идёт через общий HTTP dispatch; отдельный тест подтверждает lifecycle + CORS.
- [x] Duplicate/shadow detector различает methods.
- [x] Typed client и Node declaration smoke.
- [x] Полный `bun run verify` зелёный — 872 теста + build/smoke/consumer lane.

## Acceptance

- [x] File и link-preview HEAD routes выражаются contract-ом без raw fallback.
- [x] `HEAD` остаётся HTTP-only и не попадает в MCP/Agent/CLI.
- [x] GET не получает скрытого автоматического HEAD alias.
- [x] `serveFile` и contract router больше не противоречат друг другу.

## Что сделано

- [x] **Contract:** `packages/core/src/contract/define.ts` публикует explicit
      `HeadEndpointDef` и запрещает несовместимые request/tool поля типами и runtime guard.
- [x] **Server:** `packages/core/src/server/create.ts` маршрутизирует HEAD через
      обычный lifecycle и принудительно убирает body, сохраняя status/headers;
      CORS default включает HEAD.
- [x] **Client:** `packages/core/src/browser/http.ts` и `browser/client.ts`
      поддерживают typed HEAD как raw `Response`; URL builder использует тот же planner.
- [x] **OpenAPI:** `packages/core/src/server/openapi.ts` публикует bodyless HEAD response.
- [x] **Tests:** `packages/core/tests/head-contract.test.ts` покрывает routing,
      params/wildcard/query, `Allow`, `serveFile`, ошибочный body, client и OpenAPI.
- [x] **Docs:** обновлены contracts/client/server guides, API reference, changelog,
      generated llms и ADR 0053 с индексом.
- [x] **Что НЕ делалось:** implicit GET→HEAD alias, tool exposure и raw-route shim
      сознательно не добавлялись.
