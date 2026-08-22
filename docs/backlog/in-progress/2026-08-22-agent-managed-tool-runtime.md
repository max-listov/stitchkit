---
title: "Managed agent tools and run fencing"
description: "Соединить mountAgent с run identity, pre-effect admission, post-effect settlement и idempotency boundary."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-loop-and-stream-runtime.md
  - docs/backlog/in-progress/2026-08-22-agent-session-coordination.md
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

- [ ] Сопоставить current mount/execute/lifecycle boundaries with required run context.
- [ ] Спроектировать lifecycle composition and pre/post fence outcomes.
- [ ] Определить internal stale/superseded control signal and loop unwinding semantics.
- [ ] Определить parallel tool, timeout, abort and late-result semantics.
- [ ] Передать stable idempotency key без навязывания business storage.
- [ ] Интегрировать loop checkpoints and terminal decisions.
- [ ] Покрыть tool started after fence loss and non-cooperative settlement.

## Acceptance

- [ ] Superseded run не начинает новый managed tool after fence loss.
- [ ] Уже начавшийся effect может завершиться, но stale result не становится canonical.
- [ ] Custom hook/prepare-step cannot bypass managed fence.
- [ ] Fence rejection не попадает в prompt и не позволяет старому loop начать следующий model step.
- [ ] Low-level `mountAgent` остается independent usable surface.
- [ ] Raw provider/vendor cause не уходит caller-у или в model prompt.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: tool API composition, parallelism and consumer ergonomics.
- [x] Plan validator 2: pre-effect fence, settlement and idempotency boundaries.
- [ ] Implementation validator 1: mountAgent/lifecycle integration and compatibility.
- [ ] Implementation validator 2: stale/parallel/non-cooperative tool race probes.
