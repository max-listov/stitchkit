---
title: "CAS-safe agent history compaction"
description: "Дать structured compaction по immutable snapshot cursor без delete-then-insert races и domain summary lock-in."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/in-progress/2026-08-22-agent-prompt-context-runtime.md
---

# CAS-safe agent history compaction

## Зачем

Current consumers повторяют threshold, recent-turn protection, process locks, summary prompt и
multi-write replacement. Process-local lock не защищает от другого process или нового input между
delete/insert. Compaction должна быть atomic store transition над immutable snapshot.

## Результат

- Compactor читает snapshot cursor/version и предлагает replacement только для точного range из
  provider-valid turn groups, не произвольных rows.
- `replaceCompactedRange(expectedCursor, ...)` атомарно применяет или возвращает conflict; partial
  delete/insert невозможен по contract.
- Preset владеет execution/merge mechanics, consumer задаёт typed structured summary schema/content.
- Protected recent turns, unmatched tools и provider-critical parts не теряются.
- `none`, preset и custom compactor имеют одинаковый lifecycle/error contract.

## План

- [ ] Определить provider-valid turn grouping, eligible range и immutable cursor semantics.
- [ ] Спроектировать typed summary/merge contract и chained summaries.
- [ ] Задать CAS conflict retry/recompute policy и bounded attempts.
- [ ] Обработать summary failure, concurrent input/run и oversized single turn.
- [ ] Добавить intentionally non-atomic adapter в conformance probes.
- [ ] Документировать distributed-store capability requirement.

## Acceptance

- [ ] Compaction не удаляет protected turn, unmatched tool result или newer-than-snapshot record.
- [ ] Summary строится вне store lock и применяется только CAS к исходному snapshot.
- [ ] CAS conflict никогда не ретраится со stale summary без recompute.
- [ ] Failure оставляет original history canonical и readable.
- [ ] Standard consumer не пишет lock/delete/insert compaction engine.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: policy/schema ergonomics and information preservation.
- [x] Plan validator 2: snapshot/CAS correctness, conflicts and crash atomicity.
- [ ] Implementation validator 1: store capability integration and typed summaries.
- [ ] Implementation validator 2: concurrent input/run and broken-adapter probes.
