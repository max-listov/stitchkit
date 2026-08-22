---
title: "Managed agent tools and run fencing"
description: "Соединить mountAgent с run identity, pre-effect admission, post-effect settlement и idempotency boundary."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-loop-and-stream-runtime.md
  - docs/backlog/done/2026-08-22-agent-session-coordination.md
---

# Managed agent tools and run fencing

## Зачем

Stream видит tool event уже после начала execution, поэтому fencing в accumulator слишком поздно.
Runtime должен обернуть existing `mountAgent`/`ToolLifecycle`, не создавать второй tool engine, и
проверять ownership до side effect и перед принятием result.

## Результат

- Runtime tools получают run/step/call identity, existing `RuntimeContext.signal` and composed
  lifecycle without breaking low-level `mountAgent`.
- Pre-execute gate проверяет current run/fencing token до managed side effect.
- Post-settlement gate отклоняет stale result/checkpoint/publication after ownership loss.
- Fence rejection является internal control outcome: он останавливает старый loop, не превращается в
  model-facing tool failure и не принимается accumulator-ом как canonical result. Persisted
  chronology при необходимости закрывается framework-owned interrupted marker.
- Parallel tools имеют explicit admission and settlement semantics.
- External business mutation получает stable idempotency key/callback boundary; framework не
  притворяется способным отменить unmanaged/non-cooperative effect.
- Errors разделяют caller-safe envelope and internal raw cause.

## План

- [x] Сопоставить current mount/execute/lifecycle boundaries with required run context.
- [x] Спроектировать lifecycle composition and pre/post fence outcomes.
- [x] Определить internal stale/superseded control signal and loop unwinding semantics.
- [x] Определить parallel tool, timeout, abort and late-result semantics.
- [x] Передать stable idempotency key без навязывания business storage.
- [x] Интегрировать loop checkpoints and terminal decisions.
- [x] Покрыть tool started after fence loss and non-cooperative settlement.

## Acceptance

- [x] Superseded run не начинает новый managed tool after fence loss.
- [x] Уже начавшийся effect может завершиться, но stale result не становится canonical.
- [x] Custom hook/prepare-step cannot bypass managed fence.
- [x] Fence rejection не попадает в prompt и не позволяет старому loop начать следующий model step.
- [x] Low-level `mountAgent` остается independent usable surface.
- [x] Raw provider/vendor cause не уходит caller-у или в model prompt.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: tool API composition, parallelism and consumer ergonomics.
- [x] Plan validator 2: pre-effect fence, settlement and idempotency boundaries.
- [x] Implementation validator 1: mountAgent/lifecycle integration and compatibility. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: stale/parallel/non-cooperative tool race probes. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/managed-tools.ts` связывает run/step/call identity, idempotency key и fencing token до и после external effect.
- **Регрессия:** `packages/core/tests/agent-runtime-fence.test.ts::uses an internal control outcome before a stale tool effect`; `packages/core/tests/agent-runtime-fence.test.ts::rejects a late non-cooperative result after ownership changes`.
- **Compatibility:** low-level `mountAgent` остаётся независимым; полный existing tools suite прошёл в `bun run verify`.
