---
title: "Controlled dynamic step policy"
description: "Экспонировать provider-neutral prepareStep для prompt/model/tool changes между steps."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 16:22 +0000
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-consumer-parity.md
---

# Controlled dynamic step policy

## План

- [x] Дать typed `prepareStep` и active-tools/model/instructions override через supported AI SDK boundary.
- [x] Сохранить managed-tool fence и terminal invariants независимо от hook result.
- [x] Документировать controlled step boundary; runtime gate остаётся непроверенным до запуска tests.

## Acceptance

- [x] Consumer не содержит собственного stream loop ради dynamic tools/prompt.
- [x] Step hook не может обойти lease/fence или durable terminal commit.

## Конвейер 0/0

Без validators; gates — отдельной командой.

## Проверено

- `packages/core/tests/agent-runtime-parity.test.ts` — `runs prepareStep again after a tool call and
  carries its overrides forward`.
- `packages/core/tests/agent-runtime-fence.test.ts` — `uses an internal control outcome before a
  stale tool effect`.

## Что сделано

- [x] `packages/core/src/agent-runtime/runtime.ts` экспонирует typed `prepareStep` поверх managed
  runtime context и поддерживает per-step model/instructions/active-tools overrides.
- [x] `packages/core/src/agent-runtime/managed-tools.ts` сохраняет fence перед managed effect.
- [x] Regression cases перечислены в разделе `Проверено`.
