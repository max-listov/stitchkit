---
title: "Unified agent-run observability and usage accounting"
description: "Дать отдельный AgentRunEvent поверх shared managed sink lifecycle, не смешивая request, UI и provider events."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-loop-and-stream-runtime.md
---

# Unified agent-run observability and usage accounting

## Зачем

Consumers отдельно считают run/step duration, TTFT, queue wait, interrupt latency, cache tokens,
cost and terminal reasons. Existing observability принимает `RequestEvent`; long-running agent run
может не иметь initiating HTTP request. Fake request или mixed request/UI union неверны.

## Результат

- Отдельный Zod-first `AgentRunEvent` с explicit root run trace and optional parent trace.
- Existing bounded buffer/filter/flush/close mechanics обобщены или переиспользованы внутренне без
  второго lifecycle engine.
- Usage/cost provenance различает `provider-reported | computed | estimated | unavailable`.
- Выигравший terminal CAS создаёт stable event ID; in-memory sink delivery честно at-most-once per
  execution, а cross-crash exactly-once требует consumer transactional outbox/dedupe.
- Prompt/message/tool payload and provider raw cause excluded by default.

## План

- [ ] Определить event vocabulary после loop/session contracts.
- [ ] Выделить shared sink manager либо отдельный agent sink поверх shared internal lifecycle.
- [ ] Связать run/step/model/tool spans with AsyncLocal trace context.
- [ ] Нормализовать usage, cost, TTFT, queue and settlement timings.
- [ ] Задать opt-in, filtering, redaction, capacity and sink-failure behavior.
- [ ] Проверить duplicate terminal callbacks, late results and failing sink.

## Acceptance

- [ ] Existing RequestEvent sinks не получают agent events без opt-in.
- [ ] Sink failure не ломает run and remains diagnosable.
- [ ] Runtime emits one terminal state event; delivery guarantee documented separately.
- [ ] Missing usage/cost не изображается нулём.
- [ ] UI events and operator events remain distinct protocols.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: operator usefulness, event ergonomics and migration.
- [x] Plan validator 2: trace identity, sink lifecycle, privacy and terminal semantics.
- [ ] Implementation validator 1: schemas/adapters/docs and backward compatibility.
- [ ] Implementation validator 2: parallel tools, late callbacks and failing-sink probes.
