---
title: "Deterministic conformance and race probes for agent runtimes"
description: "Проверять runtime controllable partial-order scenarios без flaky sleeps или real-provider dependence."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-session-coordination.md
---

# Deterministic conformance and race probes for agent runtimes

## Зачем

Correctness определяется order: late chunk, abort without settlement, tool after supersession,
stale checkpoint, compaction conflict, duplicate terminal and simultaneous inputs. Promises plus
wall-clock sleeps это не доказывают.

## Результат

- Controllable model/tool/store/publisher/sink drivers with explicit barriers.
- Typed trace and partial-order assertions for admission, steps, tools, checkpoints, publication,
  settlement and terminal commit.
- Scenario groups по protocol/store, loop, coordination, compaction, delivery and observability.
- Intentionally broken drivers: abort-as-settlement, late checkpoint, new tool after fence,
  non-atomic compaction and duplicate terminal.
- Manifest также включает crash after durable input before scheduling and tool started after fence
  loss.
- Harness сначала internal; public `stitchkit/testing` export только после доказанного external use.
- Optional live-provider lane is non-blocking contract probe, не deterministic release gate.

## План

- [x] Определить internal driver protocol, barriers and bounded teardown.
- [x] Реализовать grouped semantic manifests and trace assertions.
- [x] Покрыть cooperative/non-cooperative tool, never-settling model and store/sink failure.
- [x] Покрыть queue/interrupt/debounce/stop/timeout/shutdown and concurrent compaction.
- [x] Доказать, что broken drivers reliably fail expected invariants.
- [x] Подключить manifest к packed Bun/Node fixtures.

## Acceptance

- [x] Correctness tests не используют arbitrary wall-clock sleep.
- [x] Every scenario has bounded teardown, включая never-settling driver.
- [x] Trace proves predecessor/successor, tool/publication and CAS ordering.
- [x] Broken implementations fail for the intended reason.
- [x] Packed fixture imports only public package entrypoints.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: scenario coverage and useful diagnostics.
- [x] Plan validator 2: determinism, adversarial scheduling and teardown guarantees.
- [x] Implementation validator 1: internal driver API and packed integration. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: mutation-style broken implementations and flake audit. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/testing.ts` даёт bounded barrier, semantic trace assertions и race driver; `packages/core/src/testing/agent-store-conformance.ts` покрывает store races.
- **Регрессия:** `packages/core/tests/agent-runtime-race.test.ts::proves abort request, actual settlement and successor admission order`; `packages/core/tests/agent-runtime-race.test.ts::broken partial orders fail with the intended diagnostic`; `packages/core/tests/agent-runtime-race.test.ts::never-settling barriers have bounded teardown`.
- **Packed proof:** full и Node consumer fixtures импортируют race helpers только из `stitchkit/testing` и проходят tarball lane.
