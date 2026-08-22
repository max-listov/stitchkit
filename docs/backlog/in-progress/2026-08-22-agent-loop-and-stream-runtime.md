---
title: "Managed stream-first multi-step agent loop"
description: "Дать единый AI SDK stream accumulator, step policy, bounded checkpoints и terminal result."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/in-progress/2026-08-22-agent-model-provider-registry.md
  - docs/backlog/in-progress/2026-08-22-agent-runtime-delivery-events.md
---

# Managed stream-first multi-step agent loop

## Зачем

Consumers повторяют `fullStream` switch, text/reasoning/tool accumulation, checkpoints, usage and
terminal metadata. Это central value slice и единственное место, которое должно знать unstable AI
SDK event union.

## Результат

- V1 stream-first; terminal result собирается из managed stream без отдельного generate engine.
- Canonical accumulator покрывает text, reasoning/provider parts, sources/files, tool input/call/
  result/error, step finish, empty completion, abort and provider failure.
- Configurable bounded checkpoint policy не пишет store на каждый delta.
- Перед model call создаётся durable run/assistant draft; checkpoint и terminal CAS используют
  expected `runId + version`.
- Step policy покрывает max steps, repeated tool errors, active tools and stop conditions; durable
  human approval/resume остаётся non-goal без отдельной state machine.
- Loop агрегирует normalized usage and timings, но delivery/observability публикуют свои protocols.

## План

- [ ] Сопоставить supported SDK `fullStream` union с engine transitions.
- [ ] Определить accumulator/step/terminal states и stable identities.
- [ ] Интегрировать prompt, history, model, tools, run signal/fence and store operations.
- [ ] Спроектировать bounded checkpoint and terminal commit policy.
- [ ] Запретить automatic whole-loop retry после side-effectful tool без replay/idempotency proof.
- [ ] Запретить hooks/prepare-step обходить fence или terminal invariant.
- [ ] Покрыть incomplete tools, thought signatures, empty/truncated output and abort.

## Acceptance

- [ ] Standard consumer не содержит SDK stream switch.
- [ ] Каждый checkpoint/tool result связан с run/step/call identity.
- [ ] Abort, provider failure, policy stop and success различимы terminal result-ом.
- [ ] SDK upgrade локализован adapter/runtime tests.
- [ ] Late parts не меняют canonical terminal state.
- [ ] Tool execution fencing происходит в managed lifecycle до side effect, не постфактум в stream.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: loop API, hooks and consumer ergonomics.
- [x] Plan validator 2: event completeness, checkpoints, fence and terminal correctness.
- [ ] Implementation validator 1: SDK compatibility/types and deletion proof.
- [ ] Implementation validator 2: stream/tool/abort/provider failure probes.
