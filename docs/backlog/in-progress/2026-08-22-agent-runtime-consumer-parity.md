---
title: "Agent runtime parity for mature consumers"
description: "Зонтичный migration-parity slice: coalescing, step policy, rich instructions/history, timeout и tool events."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-runtime-pending-input-coalescing.md
  - docs/backlog/done/2026-08-22-agent-runtime-dynamic-step-policy.md
  - docs/backlog/done/2026-08-22-agent-runtime-provider-aware-instructions.md
  - docs/backlog/done/2026-08-22-agent-runtime-multimodal-history.md
  - docs/backlog/done/2026-08-22-agent-runtime-idle-timeout.md
  - docs/backlog/done/2026-08-22-agent-runtime-rich-tool-events-stop-policies.md
---

# Agent runtime parity for mature consumers

## Зачем

Первый runtime slice удаляет базовый loop/session glue, но зрелый consumer пока потеряет шесть
наблюдаемых поведений. Миграция допустима только как behavioral parity, а не как упрощение продукта.

## Результат

Один coherent optional runtime поддерживает coalesced successor run, controlled per-step policy,
provider metadata в system instructions, multimodal history, inactivity timeout, rich safe tool
events и named custom stop policies. Low-level путь остаётся независимым.

## План

- [x] Реализовать шесть связанных capability tasks без consumer-specific API.
- [x] Синхронизировать public types, runtime protocol, docs, changelog и regression coverage.
- [x] Выполнить packed Bun/Node package proof.

## Acceptance

- [ ] Зрелый consumer может удалить соответствующие coordinator/loop adapters без потери поведения.
- [x] Новые возможности opt-in и не меняют простой текущий путь.
- [x] Public repository не раскрывает downstream identities или domain context.

## Конвейер 0/0

Plan validators: 0. Implementation validators: 0. Gates запускаются только отдельной командой.

## Проверено

- Шесть behavioral capability покрыты точными cases в `packages/core/tests/agent-runtime-parity.test.ts`,
  `agent-runtime-terminal.test.ts`, `agent-runtime-store.test.ts`, `agent-runtime-history.test.ts`,
  `agent-runtime-prompt-models.test.ts` и `agent-runtime-fence.test.ts`.
- `bun run verify` подтверждает lint, typecheck, tests, build, Node smoke, packed consumer lanes и
  starter lanes.
- Реальная deletion migration остаётся отдельным consumer-owned доказательством и не закрыта
  package fixture-ом.
