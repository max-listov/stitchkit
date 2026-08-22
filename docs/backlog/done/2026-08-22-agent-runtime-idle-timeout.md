---
title: "Managed inactivity timeout"
description: "Прерывать stalled run по отсутствию stream activity, сбрасывая timer на каждом event."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 16:22 +0000
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-consumer-parity.md
---

# Managed inactivity timeout

## План

- [x] Добавить opt-in `idleTimeoutMs` с run-scoped AbortSignal.
- [x] Сбрасывать deadline на каждом model stream event и очищать timer terminally.
- [x] Отличать timeout от user interrupt, shutdown и provider failure.

## Acceptance

- [x] Активный stream не прерывается при общей длительности больше timeout.
- [x] Stalled stream получает durable terminal reason `timeout` без late mutation.

## Конвейер 0/0

Без validators; gates — отдельной командой.

## Проверено

- `packages/core/tests/agent-runtime-parity.test.ts` — `resets the inactivity deadline on stream
  activity`, `terminalizes a stalled stream with the durable timeout reason`.

## Что сделано

- [x] `packages/core/src/agent-runtime/runtime.ts` создаёт run-scoped inactivity deadline, сбрасывает
  его на каждом stream event и освобождает timer перед terminal commit.
- [x] `packages/core/src/agent-runtime/schemas.ts` хранит отдельный durable terminal reason `timeout`.
- [x] Regression cases перечислены в разделе `Проверено`.
