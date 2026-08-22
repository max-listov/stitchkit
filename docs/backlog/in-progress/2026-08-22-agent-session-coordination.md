---
title: "Managed agent sessions, input scheduling and run fencing"
description: "Объединить durable admission, INTERRUPT/QUEUE, settlement, shutdown и managed side-effect fencing в keyed lifecycle."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/in-progress/2026-08-22-agent-runtime-race-probes.md
---

# Managed agent sessions, input scheduling and run fencing

## Зачем

Consumers повторяют keyed maps, debounce, pending inputs, timeout, shutdown and `AbortController`.
`abort(); startNext()` допускает overlap: abort request не равен settlement. Framework должен дать
явную process-local state machine, не обещая остановить уже начавшийся non-cooperative effect.

Published `0.56.2` also keeps admission identity private: `submit()` generates the input, run and
assistant IDs internally, while the public ticket exposes only `accepted: Promise<void>` and the
terminal result. A consuming HTTP facade that must return durable user/assistant placeholders as
soon as admission commits cannot recover the assigned successor identity without observing store
internals or depending on `generateId()` call order. Coalescing makes a caller-predicted run ID
incorrect because the input may join an existing queued successor.

## State model

```text
accepted -> debouncing | queued -> admitted -> running
running -> interrupt-requested -> execution-settled
running -> execution-settled
execution-settled -> terminal-CAS-committed -> successor admission
```

`execution-settled` — ephemeral fact: loop завершён и нет in-flight managed-tool callbacks. Полный
settlement barrier завершается только после atomic terminal CAS вместе с canonical assistant state.
Successor не допускается между этими точками. V1 strict: hung predecessor блокирует lane; detach не
предлагается как single-owner mode.

## Результат

- Explicit runtime instance с per-key `INTERRUPT | QUEUE`, optional debounce/coalescing and bounded
  cleanup; никаких hidden module-global maps.
- Typed stop/interrupt/timeout/shutdown reasons and close/drain lifecycle.
- Additive caller-provided admission record IDs plus an admission receipt carrying the actually
  assigned `runId`, `assistantMessageId` and snapshot version; the existing
  `accepted: Promise<void>` contract remains available.
- Run identity, signal and fence проходят через existing `RuntimeContext.signal` and composed
  `ToolLifecycle`; fence проверяется до admission нового managed side effect и до publication.
- Recovery читает durable store snapshot. Replay/transport и distributed lease implementation вне
  coordinator; durable active/queued records, startup scan/outbox and lease/fencing-token boundaries
  заданы отдельным store contract.

## План

- [ ] Зафиксировать transition/action table and linearization points.
- [x] Спроектировать submit ticket, run handle, batching and lifecycle hooks.
- [x] Добавить stable caller IDs и фактический admission receipt без зависимости consumer-а от
      store internals или порядка вызовов `generateId()`.
- [ ] Реализовать execution settlement -> terminal CAS -> ownership release barrier.
- [ ] Интегрировать pre-tool and pre-publication fence without breaking `mountAgent`.
- [ ] Определить hung predecessor, shutdown and bounded cleanup policies.
- [ ] Документировать multi-process lease/CAS and external-effect idempotency boundaries.
- [ ] Прогнать deterministic race matrix.

## Acceptance

- [ ] `signal.aborted` никогда не считается settlement.
- [ ] Successor admission невозможен до выигравшего predecessor terminal CAS.
- [ ] Superseded run не получает новое managed-tool admission или canonical publication ownership.
- [ ] Уже начавшийся non-cooperative effect не объявляется отменённым/откаченным framework-ом.
- [ ] Pending inputs ordered; domain merge не выдумывается framework-ом.
- [ ] New, duplicate and coalesced submit возвращают одну durable identity; при coalescing receipt
      указывает существующий assigned successor, а не отброшенный proposed run.
- [ ] Consumer может вернуть accepted user/assistant placeholders до terminal result, не создавая
      второй coordinator или shadow persistence path.
- [ ] Hung lane behavior explicit and bounded cleanup does not falsify settlement.
- [ ] Lane state не удаляется zombie cleanup-ом до actual predecessor settlement.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: input UX, debounce/queue, recovery and shutdown API.
- [x] Plan validator 2: linearizability, settlement, fencing and multi-process boundary.
- [ ] Implementation validator 1: public API/runtime integration and deletion proof.
- [ ] Implementation validator 2: adversarial races, hung predecessor and late effects.

## Consumer admission slice

- [x] `packages/core/src/agent-runtime/runtime.ts` принимает optional stable record IDs и отдаёт
      фактический assigned successor через `ticket.admission`, сохраняя `ticket.accepted`.
- [x] `packages/core/tests/agent-runtime-terminal.test.ts` — `accepts caller record ids and exposes
      the assigned admission identity` и coalescing assertions доказывают immediate placeholder и
      shared successor identity.
- [x] `docs/guide/agent-runtime.md`, `docs/api/reference.md` и `CHANGELOG.md` синхронизированы с
      additive public API.
