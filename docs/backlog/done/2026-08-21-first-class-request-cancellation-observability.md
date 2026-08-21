---
title: "First-class request cancellation in observability"
description: "Сохранить structured telemetry клиентских отмен без превращения их в failures и без изменения поведения существующих RequestEvent sinks по умолчанию."
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21 04:31 +0000
related:
  - docs/backlog/done/2026-08-21-client-closed-http-request-cancellation.md
  - docs/decisions/0042-the-audit-row-may-name-the-cause.md
  - docs/decisions/0097-request-cancellation-is-an-opt-in-observability-outcome.md
---

# First-class request cancellation in observability

## Зачем

HTTP client disconnect должен быть штатной cancellation, а не application
failure. Patch-классификация оставляет такой outcome в access log как
`499/info`, но намеренно не создаёт `RequestEvent`: текущая модель имеет только
`ok: boolean`, поэтому cancellation row с `ok: false` неотличим для legacy sink
от настоящего отказа, а `ok: true` был бы семантически ложным.

Это убирает false incidents, но structured request sink теряет возможность
считать отмены — например, сравнивать их частоту между rolling releases. Нужен
first-class outcome, который не меняет существующие sink/filter semantics
молча и не требует парсить access logs.

## Результат

- `RequestEvent` умеет явно представить `cancelled` отдельно от success и
  failure.
- Existing sinks не начинают получать новые cancellation rows после обычного
  dependency bump: `request.includeCancelled` по умолчанию `false`, а включение
  является явным opt-in.
- Cancellation event содержит transport attribution, operation identity,
  trace, duration и статус `499`, но не содержит application error code/message.
- Filters, sink diagnostics и drain semantics одинаковы для cancellation и
  остальных admitted events.
- `RequestEvent.outcome?: 'cancelled'` появляется только на opt-in cancellation
  rows. Legacy `ok` остаётся success boolean и равен `false` для cancellation;
  opt-in consumers сначала проверяют `outcome`, затем `ok`.
- Документация объясняет этот контракт и способ отличать cancellation без
  эвристик по status/message.

## План

- [x] Зафиксировать ADR для трёхсоставной модели `succeeded | failed |
      cancelled` и её совместимости с существующим `ok: boolean`.
- [x] Добавить `RequestEvent.outcome?: 'cancelled'` и
      `RequestObservabilityConfig.includeCancelled?: boolean` с default `false`.
- [x] Расширить request observability completion API внутренним typed outcome,
      не заставляя HTTP dispatcher подделывать application error.
- [x] Проецировать подтверждённый HTTP client disconnect в structured
      cancellation event со статусом `499` и без error metadata.
- [x] Определить transport-neutral vocabulary: проверить HTTP, MCP, Agent и CLI
      cancellations и явно задокументировать, какие из них означают caller
      cancellation operation, а какие — только прекращение ожидания.
- [x] Добавить type/public-surface, sink/filter, sanitisation, diagnostics,
      ordering и drain regressions.
- [x] Обновить observability guide, API reference, generated consumer docs,
      changelog и upgrading guide при необходимости.
- [x] Прогнать полный `bun run verify` и packed consumer lane.

## Acceptance

- [x] Structured sink может отличить cancellation от success/failure без
      проверки status code, error message или runtime-specific error type.
- [x] Legacy consumer, который знает только `ok`, не получает новые
      cancellation rows без явного opt-in или documented migration.
- [x] Cancellation row не содержит `errorCode`, `errorMessage` или
      `errorDetail`, но сохраняет identity/trace/duration fields.
- [x] HTTP `client_closed` проецируется ровно один раз как `499/cancelled`, когда
      structured cancellation emission включена.
- [x] Отключённая structured emission не убирает canonical `499/info` access log.
- [x] Ordinary application errors и successful requests сохраняют прежние
      event fields, ordering и sink behavior.
- [x] Cross-transport cancellation matrix зафиксирована тестами и документацией;
      unsupported semantics не заявлены как parity.
- [x] Публичное изменение классифицировано как additive/default-preserving и
      полностью описано под `[Unreleased]`; публикация исключена текущим
      мандатом и остаётся отдельным решением владельца.

## Конвейер 0/0

- [x] Public model выбран по текущим `RequestEvent`, `HttpRequestCompletion` и
      sink semantics; plan validators не запускаются по конвейеру `0/0`.
- [x] ADR, public types, runtime projection и regressions реализованы.
- [x] Focused и полный release-equivalent gates зелёные.
- [x] Implementation validators не запускаются по конвейеру `0/0`.
- [x] Задача закрыта в `done` с точными файлами и test-case evidence.

## Что сделано

- [x] `docs/decisions/0097-request-cancellation-is-an-opt-in-observability-outcome.md`
      фиксирует default-off compatibility contract и transport vocabulary.
- [x] `packages/core/src/observability/event.ts` и `audit.ts` добавляют
      `RequestEvent.outcome?: "cancelled"` и
      `RequestObservabilityConfig.includeCancelled?: boolean` с default `false`.
- [x] `packages/core/tests/http-client-disconnect.test.ts` cases `an opted-in
      request sink receives one structured cancellation row` и `opted-in
      cancellation rows use the ordinary filter, close and drop lifecycle`
      доказывают projection, sanitisation и общий sink lifecycle.
- [x] `packages/core/tests/audit-tool-event.test.ts` case `MCP protocol
      cancellation stays nested and does not impersonate HTTP cancellation`
      закрепляет отсутствие ложной cross-transport parity.
- [x] Public guide/API/changelog синхронизированы, generated consumer docs
      пересобраны штатным build, полный `bun run verify` и packed consumer lane
      завершились с exit code `0`.
