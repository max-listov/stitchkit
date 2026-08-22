---
title: "Agent runtime product contract, VISION and ADR"
description: "До кода зафиксировать product promise, ownership, state machines, package graph и связь с существующим tool runtime."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-runtime-capability-audit.md
---

# Agent runtime product contract, VISION and ADR

## Зачем

Это новый product boundary Stitchkit, а не локальная utility. До public types нужно решить, чем
framework владеет, какие гарантии даёт process-local runtime, где начинаются durable store,
distributed coordination, delivery и domain policy. Иначе дочерние API разойдутся.

## Результат

- `VISION.md` формулирует optional agent application runtime и independent low-level path.
- Новый ADR фиксирует ownership table, package graph и relation к существующим decisions.
- State/action tables покрывают input acceptance, run admission, streaming/checkpoint, interrupt,
  settlement, terminal commit, publication, shutdown и crash recovery.
- Выбраны internal engine protocol с typed extensions, language-model-only v1 и process-local runtime
  с explicit distributed lease/store boundary.
- Зафиксированы non-goals: generic jobs/workers, UI/transport, ORM, business-effect idempotency,
  durable approvals/resume и media-generation catalog.

## План

- [ ] Превратить audit matrix в ownership и responsibility tables.
- [ ] Выписать states, transitions, actions и linearization points.
- [ ] Определить coherent first public slice и dependency graph.
- [ ] Зафиксировать additive-versus-breaking release classification.
- [ ] Добавить ADR и строку в decisions index; синхронизировать VISION.
- [ ] Проверить решения против двух structurally different integration sketches.

## Acceptance

- [ ] У каждого state mutation, side effect и event один явный owner.
- [ ] Product contract не обещает distributed exactly-once или cancellation уже начавшегося external
  effect.
- [ ] Child tasks ссылаются на одни и те же state/ownership terms.
- [ ] Public API implementation не начинается до принятия ADR.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: product promise, non-goals и consumer ergonomics.
- [x] Plan validator 2: state completeness, linearization points и architectural consistency.
- [ ] Implementation validator 1: VISION/ADR/index/docs synchronization.
- [ ] Implementation validator 2: API-to-contract conformance and hidden ownership audit.
