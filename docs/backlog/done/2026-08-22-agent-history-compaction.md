---
title: "CAS-safe agent history compaction"
description: "Дать structured compaction по immutable snapshot cursor без delete-then-insert races и domain summary lock-in."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/done/2026-08-22-agent-prompt-context-runtime.md
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

- [x] Определить provider-valid turn grouping, eligible range и immutable cursor semantics.
- [x] Спроектировать typed summary/merge contract и chained summaries.
- [x] Задать CAS conflict retry/recompute policy и bounded attempts.
- [x] Обработать summary failure, concurrent input/run и oversized single turn.
- [x] Добавить intentionally non-atomic adapter в conformance probes.
- [x] Документировать distributed-store capability requirement.

## Acceptance

- [x] Compaction не удаляет protected turn, unmatched tool result или newer-than-snapshot record.
- [x] Summary строится вне store lock и применяется только CAS к исходному snapshot.
- [x] CAS conflict никогда не ретраится со stale summary без recompute.
- [x] Failure оставляет original history canonical и readable.
- [x] Standard consumer не пишет lock/delete/insert compaction engine.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: policy/schema ergonomics and information preservation.
- [x] Plan validator 2: snapshot/CAS correctness, conflicts and crash atomicity.
- [x] Implementation validator 1: store capability integration and typed summaries. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: concurrent input/run and broken-adapter probes. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/compaction.ts` выполняет structured CAS compaction с bounded `maxAttempts`, fresh reload и обязательным recompute summary после conflict.
- **Регрессия:** `packages/core/tests/agent-runtime-compaction.test.ts::recomputes from a fresh snapshot after a CAS conflict within a bounded attempt count`; `packages/core/tests/agent-runtime-compaction.test.ts::leaves canonical history unchanged when summary construction fails`.
- **Atomicity proof:** `examples/agent-store-prisma/adapter.test.ts::rolls compaction history and state back together`.
