---
title: "Deterministic conformance and race probes for agent runtimes"
description: "Проверять runtime controllable partial-order scenarios без flaky sleeps или real-provider dependence."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-session-coordination.md
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

- [ ] Определить internal driver protocol, barriers and bounded teardown.
- [ ] Реализовать grouped semantic manifests and trace assertions.
- [ ] Покрыть cooperative/non-cooperative tool, never-settling model and store/sink failure.
- [ ] Покрыть queue/interrupt/debounce/stop/timeout/shutdown and concurrent compaction.
- [ ] Доказать, что broken drivers reliably fail expected invariants.
- [ ] Подключить manifest к packed Bun/Node fixtures.

## Acceptance

- [ ] Correctness tests не используют arbitrary wall-clock sleep.
- [ ] Every scenario has bounded teardown, включая never-settling driver.
- [ ] Trace proves predecessor/successor, tool/publication and CAS ordering.
- [ ] Broken implementations fail for the intended reason.
- [ ] Packed fixture imports only public package entrypoints.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: scenario coverage and useful diagnostics.
- [x] Plan validator 2: determinism, adversarial scheduling and teardown guarantees.
- [ ] Implementation validator 1: internal driver API and packed integration.
- [ ] Implementation validator 2: mutation-style broken implementations and flake audit.
