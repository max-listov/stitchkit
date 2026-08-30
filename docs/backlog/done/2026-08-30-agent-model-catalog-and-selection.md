---
title: Agent model catalog and runtime selection
description: Add a provider-neutral catalog contract with complete OpenRouter discovery, current rankings and per-conversation next-run selection.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
pipeline: agent-tui-productization
order: 2
depends-on: —
completed: 2026-08-30
---

# Agent model catalog and runtime selection

## Зачем

A terminal host should not freeze one model in a startup closure or invent its own catalog schema.
Users need to search every compatible model, see which ones are currently popular, compare
available benchmark signals and switch the model used by the next run without rebuilding the
harness.

## Результат

- Core defines a provider-neutral model catalog query/result schema and selection store boundary.
- The OpenRouter adapter returns every compatible model and joins official weekly popularity and
  benchmark data when available.
- Every rank or score carries source and `asOf`; missing measurements remain unknown.
- Selection is scoped per conversation, is pinned in durable input/run evidence before provider
  execution and can be session-only or persisted by the host.

## План

- [x] Add Zod-first catalog, capability, pricing, popularity and benchmark schemas.
- [x] Implement bounded, timeout-aware OpenRouter catalog and benchmark requests.
- [x] Join provider records by canonical model identity without hiding unranked models.
- [x] Add a conversation-scoped selection registry usable by the existing model resolver.
- [x] Extend model resolution with the current run and its durable input evidence so recovery uses
  the pinned model rather than a later selection.
- [x] Document provider-neutral extension and OpenRouter-specific provenance.

## Acceptance

- [x] Catalog tests cover search projection, duplicates, malformed records, missing
  benchmarks, timeouts and non-success responses.
- [x] A selection changed after one run affects the next run without recreating the harness.
- [x] Two conversations can select different models without state leakage.
- [x] Recovery and approval continuation retain the model pinned for the interrupted operation.
- [x] No static “popular model” list or name-based capability inference exists.

## Что сделано

Core owns the provider-neutral catalog and per-conversation selection contracts. The OpenRouter
adapter reads the complete compatible catalog, keeps weekly popularity separate from benchmark
measurements, attaches source timestamps and isolates optional benchmark failures. The starter
pins the selected model into durable input metadata before execution.

## Регрессия

- `packages/core/tests/agent-runtime-openrouter-catalog.test.ts` — `keeps the complete popularity
  order and joins sourced benchmark facts`.
- `packages/core/tests/agent-runtime-openrouter-catalog.test.ts` — `bounds the whole catalog fan-out
  with one timeout signal`.
- `packages/tui/tests/controller.test.ts` — `keeps selections isolated per conversation and
  applies changes to the next submit`.
- `packages/tui/tests/controller.test.ts` — `continues an approval with the model pinned in durable
  run evidence`.
