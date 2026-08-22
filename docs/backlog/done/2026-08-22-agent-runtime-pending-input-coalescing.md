---
title: "Pending-input coalescing"
description: "Объединять inputs, пришедшие во время active run, в один durable successor run."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 16:22 +0000
related:
  - docs/backlog/done/2026-08-22-agent-runtime-consumer-parity.md
---

# Pending-input coalescing

## Зачем

Queue-per-input создаёт лишние model runs и теряет привычную семантику: один active run и не более
одного successor, в который атомарно добавляются все новые inputs.

## План

- [x] Дать explicit coalescing policy и stable successor identity.
- [x] Сохранять каждый input durable до scheduling и связывать несколько message ids с одним run.
- [x] Добавить regression cases для coalesced store assignment и successor execution.

## Acceptance

- [x] Несколько inputs во время active run выполняются одним successor run.
- [x] Ни один accepted input не теряется и duplicate submit не размножает messages/runs.

## Конвейер 0/0

Без plan и implementation validators; gates — отдельной командой.

## Проверено

- `packages/core/tests/agent-runtime-terminal.test.ts` — `coalesces inputs behind an active run into
  one durable successor`.
- `packages/core/tests/agent-runtime-store.test.ts` — `accepts input and queued run atomically and
  deduplicates the assignment`, `coalesces another durable input into the same queued successor run`.

## Что сделано

- [x] `packages/core/src/agent-runtime/store.ts` атомарно назначает accepted inputs одному queued
  successor и дедуплицирует повторную admission.
- [x] `packages/core/src/agent-runtime/runtime.ts` связывает coalesced tickets с одним successor
  execution без потери durable messages.
- [x] Regression cases перечислены в разделе `Проверено`.
