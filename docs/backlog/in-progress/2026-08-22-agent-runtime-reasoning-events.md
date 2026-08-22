---
title: "Transient agent reasoning events"
description: "Публиковать live reasoning lifecycle из managed agent loop без consumer-owned stream loop."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-session-coordination.md
---

# Transient agent reasoning events

## Зачем

Managed loop сохраняет reasoning в canonical assistant parts, но publisher видит
его только на durable checkpoints. Consumer с live reasoning UI вынужден либо
терять промежуточные обновления, либо снова владеть частью stream loop.

## План

- [x] Добавить ordered transient start/delta/end reasoning events.
- [x] Передавать JSON-safe provider envelope без раскрытия internal failures.
- [x] Покрыть порядок, payload и terminal coexistence regression test.
- [x] Синхронизировать guide, API reference и changelog.
- [ ] Выпустить patch и проверить GitHub/npm publication.

## Acceptance

- [x] Publisher получает reasoning lifecycle с `(runId, runtimeEpoch, sequence)`.
- [x] Delta содержит только текущий text delta, durable source остаётся checkpoint.
- [x] Provider metadata проходит canonical envelope validation.

## Что сделано

- [x] `packages/core/src/agent-runtime/events.ts` и `runtime.ts` — transient
      reasoning lifecycle с ordered identity и optional provider envelope.
- [x] Регрессия:
      `packages/core/tests/agent-runtime-parity.test.ts::publishes ordered transient reasoning lifecycle with provider metadata`.
- [x] Gates: targeted parity — 7 pass; `bun --filter stitchkit check` — green;
      `bun run verify` — green, включая packed consumers и starter browser lanes.

## Конвейер 0/0

Дополнительные plan и implementation validators не запускаются.
