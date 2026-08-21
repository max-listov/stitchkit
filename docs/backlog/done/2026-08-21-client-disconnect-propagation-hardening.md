---
title: "Harden client-disconnect propagation through body streams and error causes"
description: "Гарантировать neutral 499 при mid-stream abort и при безопасно обёрнутом runtime abort reason, не расширяя классификацию на внутренние ошибки."
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21 04:45 +0000
related:
  - docs/backlog/done/2026-08-21-client-closed-http-request-cancellation.md
  - docs/backlog/done/2026-08-21-first-class-request-cancellation-observability.md
  - docs/decisions/0097-request-cancellation-is-an-opt-in-observability-outcome.md
---

# Harden client-disconnect propagation through body streams and error causes

## Зачем

Первичная client-disconnect реализация закрывает abort до начала body read и
exact identity `error === request.signal.reason`. Остались две узкие границы:

- bounded body reader при `maxJsonBodyBytes` может уже ожидать следующий chunk,
  когда клиент закрывает transport; entry-only signal check не гарантирует, что
  pending `reader.read()` завершится;
- application/dependency layer может сохранить canonical runtime abort reason в
  стандартном `Error.cause`, но выбросить внешний error object. Exact top-level
  identity тогда теряется, хотя signal и causal chain всё ещё согласованы.

Message, runtime error code и произвольный вложенный объект не являются
доказательством cancellation. Расширение должно остаться узким: только aborted
request и exact identity canonical reason на верхнем уровне либо в bounded
standard `cause` chain.

## Результат

- Mid-stream abort прерывает bounded body read canonical signal reason и не
  возвращает partial body в JSON parser.
- Pending reader получает best-effort cancellation без unhandled rejection и
  без ожидания transport-owned cleanup перед завершением request.
- Wrapped runtime reason распознаётся через bounded, cycle-safe `Error.cause`
  chain и завершается тем же `499/info` без application error pipeline.
- Active request, unrelated wrapper, слишком глубокая или циклическая cause
  chain остаются обычными application failures.
- `[Unreleased]` остаётся release-ready для additive minor `0.57.0`; version,
  commit, tag, publish и deploy в этой задаче не выполняются.

## План

- [x] Вынести canonical request-abort reason и добавить abort-aware bounded body
      reader с deterministic cleanup.
- [x] Расширить dispatcher classifier bounded/cycle-safe cause traversal без
      message/code matching.
- [x] Добавить regression matrix для mid-stream abort, wrapped reason, unrelated,
      active, cyclic и depth-limit paths.
- [x] Актуализировать ADR, server/observability guide и `[Unreleased]` changelog.
- [x] Прогнать focused tests и полный `bun run verify`.

## Acceptance

- [x] Abort после первого body chunk завершает dispatcher как bodyless
      `499 Client Closed Request`, application handler и `onError` не вызываются.
- [x] Cancellation не может завершить bounded read partial success/JSON `400`.
- [x] Exact `request.signal.reason` в стандартной `cause` chain распознаётся
      только при `request.signal.aborted === true`.
- [x] Cause traversal имеет явный depth limit и cycle protection.
- [x] Active signal, unrelated cause, cycle и reason за depth limit остаются в
      существующем error pipeline.
- [x] Документация прямо описывает cause contract и release classification
      `0.57.0` без изменения package version.
- [x] Focused regressions и `bun run verify` зелёные.

## Конвейер 0/0

- [x] Follow-up создан по доказанным границам текущей реализации; plan и
      implementation validators не запускаются по выбранному конвейеру `0/0`.
- [x] Source, regressions и документация готовы.
- [x] Задача закрыта в `done` с точными test-case evidence.

## Что сделано

- [x] `packages/core/src/server/request-body.ts` races every bounded
      `ReadableStream` read against `Request.signal`, rejects with the canonical
      reason and starts best-effort reader cancellation.
- [x] `packages/core/src/server/create.ts` follows exact abort-reason identity
      through at most eight cycle-safe standard `cause` links without
      message/code matching.
- [x] `packages/core/tests/http-client-disconnect.test.ts` case `a mid-stream
      abort interrupts a bounded body read without parsing partial JSON`
      proves the pending-reader path returns bodyless `499` and never calls the
      handler or project `onError`.
- [x] `packages/core/tests/http-client-disconnect.test.ts` cases `a wrapped
      runtime abort reason is recognized through the standard cause chain`, `a
      wrapped abort reason with an active request remains an application error`
      and `unrelated cyclic and over-depth causes keep the ordinary error path`
      pin the positive and negative causal matrix.
- [x] `docs/decisions/0097-request-cancellation-is-an-opt-in-observability-outcome.md`,
      `docs/guide/server.md`, `docs/guide/observability.md` and `CHANGELOG.md`
      describe the bounded stream/cause contract and additive minor release
      classification.
- [x] Focused suite passed `40` tests; full `bun run verify` passed `1390` core
      tests, build, Next/Node smokes, packed consumer lane and both starter lanes.
- [x] Version, commit, tag, publish and deploy were not performed.
