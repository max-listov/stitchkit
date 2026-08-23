---
title: "Reconcile terminal commit with concurrent interrupt"
description: "Не оставлять durable run активным, когда provider completion и interrupt одновременно меняют revision."
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23T04:15:03+00:00
related:
  - docs/backlog/done/2026-08-22-agent-session-coordination.md
  - docs/backlog/done/2026-08-22-agent-runtime-pending-input-coalescing.md
  - docs/backlog/done/2026-08-22-framework-owned-agent-store-reducer.md
---

# Reconcile terminal commit with concurrent interrupt

## Зачем

Если provider заканчивает stream одновременно с durable `interrupt()`, interrupt может первым
увеличить revision активного run. Следующий terminal commit использует предыдущую revision,
получает store conflict и отклоняет execution ticket. Durable run остаётся
`interrupt_requested`, а coalesced successor не получает корректно завершённого predecessor.

## Результат

- Terminal path после CAS conflict перечитывает canonical snapshot.
- Уже terminal run завершает ticket canonical result без повторной записи.
- Принадлежащий текущему runtime `interrupt_requested` run terminalize-ится как `interrupted`.
- После settlement запускается один successor, содержащий все coalesced inputs.

## План

- [x] Вынести terminal commit reconciliation в отдельную runtime-функцию.
- [x] Различить уже terminal snapshot, совместимый concurrent interrupt и настоящий ownership
      conflict.
- [x] Добавить deterministic regression для provider completion + interrupt + трёх coalesced
      inputs.
- [x] Обновить guide, API reference и changelog.
- [x] Пройти scoped tests и полный repository gate.

## Acceptance

- [x] Terminal ticket не получает `AgentRuntimeConflictError` при выигравшем interrupt CAS.
- [x] Durable predecessor становится `interrupted`, а не остаётся active.
- [x] Три inputs объединяются в один successor и получают один terminal result.
- [x] Уже выигравший terminal commit читается как canonical результат без перезаписи.
- [x] Настоящие stale-owner/fencing conflicts по-прежнему отклоняются.

## Конвейер 0/0

Plan validators: 0. Implementation validators: 0.

## Что сделано

- [x] Runtime: `packages/core/src/agent-runtime/terminal-commit.ts` владеет bounded
      reconciliation проигравшего terminal CAS; `packages/core/src/agent-runtime/runtime.ts`
      публикует и возвращает canonical terminal projection.
- [x] Race regression: `packages/core/tests/agent-runtime-terminal.test.ts` —
      `settles an interrupt racing provider completion and runs three coalesced inputs`.
- [x] Concurrent terminal winner: `packages/core/tests/agent-runtime-terminal.test.ts` —
      `settles from the canonical terminal snapshot when another terminal CAS wins`.
- [x] Same-owner CAS retry: `packages/core/tests/agent-runtime-terminal.test.ts` —
      `retries a terminal CAS conflict while ownership remains current`.
- [x] Existing stale fencing proof retained: `packages/core/tests/agent-runtime-store.test.ts` —
      `rejects a stale checkpoint and commits terminal state once`.
- [x] Documentation: `CHANGELOG.md`, `docs/guide/agent-runtime.md`,
      `docs/architecture/agent-runtime.md` and `docs/api/reference.md` describe the reconciled
      terminal/interrupt order.
- [x] Gates: scoped terminal suite passed 11/11; `bun run verify` passed, including 1468 core
      tests, build/public types, Node smoke, packed consumer lane and both starter lanes.
