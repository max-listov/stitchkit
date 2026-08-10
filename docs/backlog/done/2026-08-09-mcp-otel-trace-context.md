---
title: MCP OpenTelemetry trace context propagation
description: Продолжить traceparent, tracestate и baggage из MCP _meta через isolated tool context, hooks и audit на HTTP и stdio.
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 17:02 +00:00
related: docs/backlog/done/2026-08-09-mcp-2026-v2-release.md
---

# MCP OpenTelemetry trace context propagation

## Зачем

MCP документирует `traceparent`, `tracestate` и `baggage` в request `_meta` как
канонический OpenTelemetry propagation surface. Stitchkit продолжает
`traceparent` из HTTP-заголовка, но MCP tool runner сейчас извлекает только
protocol/client identity. Поэтому MCP host, особенно через stdio, не может
связать свой span с lifecycle, hooks, audit и application logs Stitchkit.

Нужно продолжать trace на framework-owned MCP boundary без повторного разбора
raw body и без смешивания параллельных вызовов. Trace metadata не является
identity или authorization input.

## Результат

- Один MCP request продолжает входящий W3C trace во всех framework-owned tools.
- HTTP и stdio имеют одинаковую correlation semantics.
- Каждый параллельный tool call получает отдельный child span внутри общего
  trace и не перезаписывает соседний context.
- Невалидная или отсутствующая trace metadata безопасно создаёт локальный trace,
  не ломая business call.

## План

- [x] Найти и использовать официальный SDK v2 accessor request metadata внутри
      `ServerContext`; не читать JSON body повторно и не зависеть от private SDK
      internals.
- [x] Расширить общий W3C trace parser: `traceparent` валидируется существующим
      каноническим кодом, `tracestate` и `baggage` сохраняются как bounded
      propagation metadata без автоматического логирования содержимого.
- [x] Определить единый precedence: валидный MCP `_meta.traceparent` является
      trace parent конкретного MCP request; при его отсутствии HTTP transport
      продолжает ambient HTTP trace, а stdio создаёт новый root.
- [x] Создать MCP request context до lifecycle/validation/handler и затем
      использовать существующий `inToolCallContext` для отдельного child span
      каждого параллельного tool call.
- [x] Провести один `traceId` через `getTraceId()`, tool logger,
      `beforeToolCall`, `onToolError`, `afterToolCall` и tool `RequestEvent`;
      span/parent relationships должны оставаться корректными.
- [x] Не использовать `clientInfo`, baggage или trace identifiers для auth,
      RBAC, tenant selection или rate-limit identity.
- [x] Определить поведение для MRTR retry: каждый retry обрабатывает metadata
      текущего request; скрытое server-side trace state в `requestState` не
      добавляется.
- [x] Обновить observability guide, MCP architecture/reference и
      `[Unreleased]` changelog с HTTP/stdio примерами.

## Acceptance

- [x] Modern HTTP request только с `_meta.traceparent` сохраняет входящий
      `traceId` в handler, hooks и audit event.
- [x] Modern stdio request с тем же `_meta` даёт такую же correlation semantics
      без HTTP wrapper.
- [x] При одновременно присутствующих HTTP header и MCP `_meta` действует
      документированный precedence без двойного root/span.
- [x] Malformed/all-zero `traceparent` не принимается и создаёт новый локальный
      trace; tool call при этом продолжает выполняться.
- [x] `tracestate` и `baggage` доступны только как propagation context,
      ограничены по размеру и не попадают целиком в стандартный audit/log event.
- [x] Два параллельных MCP tool call имеют общий trace id, разные span ids и
      корректный parent span без cross-call contamination.
- [x] Failure до handler и thrown handler error сохраняют тот же trace id во
      всех error hooks/events.
- [x] MRTR initial и retry rounds не используют скрытую server session и
      следуют metadata каждого входящего request.
- [x] Existing browser HTTP trace tests, Node smoke и MCP HTTP/stdio E2E остаются
      зелёными.

## Не входит

- Полный OpenTelemetry SDK/exporter или vendor-specific telemetry backend.
- Использование trace/baggage как доверенной security identity.
- Автоматическое связывание отдельных MRTR retries при отсутствии trace metadata
  от клиента.

## Источники

- <https://modelcontextprotocol.io/seps/414-request-meta>
- <https://modelcontextprotocol.io/specification/2026-07-28/changelog>

## Что сделано

- [x] **Propagation core:** `packages/core/src/observability/trace.ts` продолжает
      W3C parent, хранит bounded `tracestate`/`baggage`, отклоняет control chars,
      over-size, over-member и all-zero metadata.
- [x] **MCP boundary:** `packages/core/src/tools/mcp-trace.ts` использует public
      SDK v2 `ServerContext.mcpReq._meta` и официальные meta-key constants;
      contract и runtime registrations входят в isolated context до runner.
- [x] **Semantics:** MCP parent имеет явный precedence над ambient HTTP;
      отсутствующий parent наследует HTTP или создаёт stdio root, invalid present
      parent открывает fresh root. Metadata не участвует в security identity.
- [x] **MRTR/concurrency/errors:**
      `packages/core/tests/mcp-v2-modern.test.ts` и
      `packages/core/tests/mcp-mrtr.test.ts` проверяют hooks/audit, thrown error,
      parallel spans и current-request metadata каждого round.
- [x] **HTTP/stdio and limits:**
      `packages/core/tests/mcp-stdio-v2.test.ts` и
      `packages/core/tests/trace-propagation.test.ts` покрывают transport parity,
      fallback, malformed values и bounds.
- [x] **Docs:** `CHANGELOG.md`, `docs/guide/observability.md`,
      `docs/architecture/mcp-semantics.md` и `docs/api/reference.md` описывают
      precedence, propagation-only поля и MRTR обязанность клиента.
- [x] **Что не делалось:** OTel SDK/exporter, trace-based auth и скрытая
      cross-round server session не добавлялись.
- [x] **Гейты:** targeted MCP matrix — 50/50; полный `bun run verify` зелёный,
      включая lint, typecheck, 985 core tests, builds, Node smoke, packed
      consumer lane и 33 starter browser E2E.
