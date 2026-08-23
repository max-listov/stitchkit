---
title: "Harden terminal reconciliation for release"
description: "Закрыть повторный CAS contention, winner-only terminal delivery и release assembly после полного dirty-tree review."
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
related:
  - docs/backlog/done/2026-08-23-agent-terminal-interrupt-cas-reconciliation.md
  - docs/backlog/done/2026-08-23-cli-default-command.md
  - docs/backlog/done/2026-08-23-cli-explicit-positionals.md
  - docs/backlog/done/2026-08-23-cli-result-exit-policy.md
  - docs/backlog/done/2026-08-23-cli-short-option-aliases.md
---

# Harden terminal reconciliation for release

## Зачем

Два независимых dirty-tree validator-а подтвердили, что fixed two-attempt terminal reconciliation
не гарантирует settlement: interrupt может выиграть первую revision, а coalesced admission —
следующий aggregate-head CAS. Кроме того, execution, проигравшая terminal CAS, повторно публикует
event победителя со своими metrics, а общий `duplicate` result contract допускает неканоническую
projection. Текущий Git index содержит промежуточный CLI snapshot и не соответствует проверенному
working tree.

## Результат

- Owned active run terminalize-ится при любом конечном числе same-owner head conflicts.
- Только execution, применившая terminal mutation, публикует terminal delivery и observability.
- Canonical terminal winner/duplicate завершает ticket canonical result без локальной подмены.
- CLI done tasks соответствуют lifecycle-формату.
- Полный reviewed tree проходит повторный двухвалидаторный аудит и готов к одному patch release.

## План

- [x] Заменить fixed-attempt terminal loop на state-driven same-owner reconciliation.
- [x] Вернуть из reconciliation точную ownership доставки: caller commit или canonical winner.
- [x] Канонизировать допустимый `duplicate` terminal result либо fail closed на неполной projection.
- [x] Добавить deterministic interleaving: interrupt, reload, conflict от coalesced admission,
      последующий terminal settlement и один successor для трёх inputs.
- [x] Добавить winner-only delivery, canonical duplicate, owner drift и fencing drift regressions.
- [x] Проверить inspectable evidence четырёх CLI done tasks, не переписывая immutable archive.
- [x] Синхронизировать architecture, guide, API reference и changelog.
- [x] Пройти scoped gates и полный `bun run verify`.
- [x] Провести повторный одинаковый read-only аудит двумя implementation validators и устранить
      подтверждённые findings.
- [x] Подготовить полный working tree к coherent index assembly и patch release.

## Acceptance

- [x] Ни interrupt, ни конечная серия coalesced admissions не оставляют owned predecessor active.
- [x] Successor начинает execution только после canonical terminal settlement predecessor.
- [x] Terminal event/metrics публикуются ровно winning execution.
- [x] Canonical winner/duplicate не возвращает локальные assistant/reason/policy.
- [x] Stale owner, fencing change и missing canonical projection остаются loud conflicts.
- [x] Два повторных валидатора не находят P0–P2 findings.
- [x] Full verify зелёный; release candidate готов к exact-SHA CI и tag gate.

## Конвейер 0/2

- [x] Plan validators: использованы два независимых full-tree audit отчёта, инициировавшие task.
- [x] Implementation validator 1: `CLEAN FOR RELEASE`, P0–P2 отсутствуют.
- [x] Implementation validator 2: `CLEAN FOR RELEASE`, P0–P2 отсутствуют.

## Что сделано

- [x] `packages/core/src/agent-runtime/terminal-commit.ts` реализует state-driven reconciliation,
      canonical snapshot priority, validated compaction fallback и caller commit ownership.
- [x] `packages/core/src/agent-runtime/runtime.ts` публикует terminal delivery, observability и
      metrics только для execution, применившей terminal CAS.
- [x] Регрессия: packages/core/tests/agent-runtime-terminal.test.ts::settles an interrupt racing provider completion and runs three coalesced inputs
- [x] Регрессия: packages/core/tests/agent-runtime-terminal.test.ts::settles from the canonical terminal snapshot when another terminal CAS wins
- [x] Регрессия: packages/core/tests/agent-runtime-terminal.test.ts::uses a duplicate terminal result as canonical without republishing it
- [x] Регрессия: packages/core/tests/agent-runtime-terminal.test.ts::rejects a malformed retained terminal projection after compaction
- [x] Регрессия: packages/core/tests/agent-runtime-terminal.test.ts::retries a terminal CAS conflict while ownership remains current
- [x] Регрессия: packages/core/tests/agent-runtime-terminal.test.ts::rejects terminal reconciliation after ownership changes
- [x] Регрессия: packages/core/tests/agent-runtime-terminal.test.ts::rejects terminal reconciliation after the fencing token changes
- [x] `docs/architecture/agent-runtime.md`, `docs/guide/agent-runtime.md`,
      `docs/api/reference.md` и `CHANGELOG.md` синхронизированы с runtime contract.
- [x] Scoped gate: 15/15 terminal tests и core typecheck зелёные 2026-08-23.
- [x] Full gate: `bun run verify` зелёный 2026-08-23, включая packed consumer и starter lanes.
- [x] Два независимых финальных read-only validator-а вернули `CLEAN FOR RELEASE` без P0–P2.
