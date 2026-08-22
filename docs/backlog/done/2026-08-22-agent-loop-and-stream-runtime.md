---
title: "Managed stream-first multi-step agent loop"
description: "Дать единый AI SDK stream accumulator, step policy, bounded checkpoints и terminal result."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/done/2026-08-22-agent-model-provider-registry.md
  - docs/backlog/done/2026-08-22-agent-runtime-delivery-events.md
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

- [x] Сопоставить supported SDK `fullStream` union с engine transitions.
- [x] Определить accumulator/step/terminal states и stable identities.
- [x] Интегрировать prompt, history, model, tools, run signal/fence and store operations.
- [x] Спроектировать bounded checkpoint and terminal commit policy.
- [x] Запретить automatic whole-loop retry после side-effectful tool без replay/idempotency proof.
- [x] Запретить hooks/prepare-step обходить fence или terminal invariant.
- [x] Покрыть incomplete tools, thought signatures, empty/truncated output and abort.

## Acceptance

- [x] Standard consumer не содержит SDK stream switch.
- [x] Каждый checkpoint/tool result связан с run/step/call identity.
- [x] Abort, provider failure, policy stop and success различимы terminal result-ом.
- [x] SDK upgrade локализован adapter/runtime tests.
- [x] Late parts не меняют canonical terminal state.
- [x] Tool execution fencing происходит в managed lifecycle до side effect, не постфактум в stream.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: loop API, hooks and consumer ergonomics.
- [x] Plan validator 2: event completeness, checkpoints, fence and terminal correctness.
- [x] Implementation validator 1: SDK compatibility/types and deletion proof. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: stream/tool/abort/provider failure probes. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/runtime.ts` и `loop.ts` владеют stream accumulator, step policy, checkpoints, terminalization и pre-effect fencing.
- **Регрессия:** `packages/core/tests/agent-runtime-parity.test.ts::runs prepareStep again after a tool call and carries its overrides forward`; `packages/core/tests/agent-runtime-parity.test.ts::distinguishes empty success from a provider-truncated terminal result`.
- **Compatibility:** packed full и Node fixtures прошли `bun run consumer-lane` только через public package entrypoints.
