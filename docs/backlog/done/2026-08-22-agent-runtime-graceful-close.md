---
title: "Graceful agent runtime close"
description: "Закрыть admission, дать active runs natural drain budget и только затем выполнять bounded shutdown abort."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-session-coordination.md
---

# Graceful agent runtime close

## Зачем

В опубликованном runtime `close({ drainTimeoutMs })` немедленно abort'ит active
execution и лишь затем ждёт settlement. Из-за этого параметр не даёт graceful
drain, а application shutdown теряет уже принятый model/tool turn.

## Результат

- Close сначала прекращает новые admissions и отклоняет ещё не начатую process-local
  queue, оставляя durable queued records recoverable.
- Active runs получают `drainTimeoutMs` на естественное завершение без abort.
- Только по исчерпанию grace budget runtime abort'ит active runs с причиной
  `shutdown` и bounded ждёт settlement через optional `forceTimeoutMs`.
- Вызов без `drainTimeoutMs` сохраняет immediate-shutdown поведение.

## План

- [x] Разделить close на admission close, natural drain и forced abort phases.
- [x] Добавить additive `forceTimeoutMs` в coordinator/runtime public options.
- [x] Покрыть natural drain, forced abort и bounded non-cooperative settlement.
- [x] Синхронизировать guide, API reference и changelog.
- [x] Прогнать targeted tests и полный release gate.
- [x] Выпустить patch и проверить npm/GitHub publication.

## Acceptance

- [x] Active run не получает abort до окончания natural drain budget.
- [x] Завершившийся в grace phase run закрывается без shutdown signal.
- [x] Просроченный run получает shutdown abort; non-cooperative settlement не
      удерживает close дольше force budget.
- [x] Новые submits после начала close fail-closed.
- [x] Pending durable work не изображается завершённым при process shutdown.

## Что сделано

### Runtime

- [x] `packages/core/src/agent-runtime/coordinator.ts` — admission close, natural
      drain, shutdown abort и bounded force settlement.
- [x] `packages/core/src/agent-runtime.ts` и `runtime.ts` — публичный additive
      `AgentSessionCloseOptions.forceTimeoutMs`.

### Regression coverage

- [x] `packages/core/tests/agent-runtime-coordinator.test.ts` — `close drains an
      active run before using the shutdown abort`, `close aborts with shutdown
      only after the drain budget expires`, `force timeout bounds a
      non-cooperative active run and closes admission`.

### Docs

- [x] `docs/guide/agent-runtime.md`, `docs/api/reference.md` и `CHANGELOG.md`
      описывают двухфазный shutdown в `0.56.4`.

### Gates

- [x] `packages/core/tests/agent-runtime-coordinator.test.ts` — 4 pass; полный
      `bun run verify` зелёный, включая packed Bun/Node consumers и starter lanes.

### Release

- [x] Release commit: `aa096c131dbdce310f208acc8d6290a12e7842bd`.
- [x] Exact-SHA CI: https://github.com/max-listov/stitchkit/actions/runs/32589019001 — success.
- [x] Release workflow: https://github.com/max-listov/stitchkit/actions/runs/32589372957 — success.
- [x] GitHub Release: https://github.com/max-listov/stitchkit/releases/tag/v0.56.4.
- [x] Public registry: `stitchkit@0.56.4` доступен через npm.

## Конвейер 0/0

Дополнительные plan и implementation validators не запускаются.
