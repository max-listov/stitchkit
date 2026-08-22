---
title: "Durable admission projection, telemetry events and startup recovery"
description: "Отдать delivery adapter-у canonical records без reread и заменить ручной startup orchestration одним framework helper."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 19:52 +0000
related:
  - docs/backlog/inbox/2026-08-22-agent-runtime-production-persistence-ergonomics.md
  - docs/backlog/done/2026-08-22-agent-runtime-delivery-events.md
  - docs/backlog/done/2026-08-22-agent-runtime-observability.md
---

# Durable admission projection, telemetry events and startup recovery

## Зачем

Durable admission receipt/event несёт не все фактические records, поэтому
product placeholder создаётся после повторного store read. Checkpoint/terminal
delivery и operator telemetry требуют ручного join usage/timings. Startup code
повторяет `scanRecoverable → context lookup → resume/abandon`.

## Результат

- Admission receipt включает actual input/run и canonical assistant placeholder;
  post-commit admission event несёт ту же projection без ложной exactly-once гарантии.
- Checkpoint/terminal events несут canonical parts plus normalized usage with
  provenance and available timings; unknown values не превращаются в zero.
- Runtime предоставляет bounded startup recovery helper с safe default: queued
  resume, acquired skip; requeue/abandon требуют replay-safe/stale-owner evidence.
- Consumer сохраняет product projection/transport, model/prompt/tools/context
  resolution и external-effect idempotency.

## План

- [x] Добавить Zod-first admission event и расширить admission receipt actual IDs.
- [x] Унифицировать checkpoint/terminal projection с normalized usage/timings.
- [x] Добавить runtime recovery API, context resolver, policy and summary result.
- [x] Покрыть duplicate/coalesced identity, no-reread publisher and restart paths.
- [x] Обновить guide/reference/changelog без transport-specific recipes in core.

## Acceptance

- [x] Accepted-response transport получает оба placeholders из одного durable event/receipt.
- [x] Duplicate и coalesced paths возвращают actual durable IDs, не proposals.
- [x] Publisher не читает store для admission/checkpoint/terminal projection.
- [x] Usage provenance/timings сохраняют unavailable отдельно от reported zero.
- [x] Recovery helper не replay-ит acquired side effect без explicit evidence.
- [x] Recovery имеет bounded per-run failure reporting and does not hide failures.

## Конвейер 2/2

- [x] Plan validation incorporated from umbrella round.
- [x] Implementation correctness review passed.
- [x] Implementation ergonomics review passed.

## Что сделано

- [x] **Runtime:** `packages/core/src/agent-runtime/runtime.ts` отдаёт actual
      input/run/assistant projection и bounded startup recovery outcomes.
- [x] **Regression:** `packages/core/tests/agent-runtime-terminal.test.ts`, cases
      `accepts caller record ids and exposes the assigned admission identity` и
      `returns the durable admission identity for a duplicate with discarded proposals`.
- [x] **Recovery:** `packages/core/tests/agent-runtime-store-driver.test.ts`, cases
      `bounded recovery resumes queued work and skips a live acquired run by default` и
      `does not resume a queued successor while an acquired predecessor is unresolved`.
