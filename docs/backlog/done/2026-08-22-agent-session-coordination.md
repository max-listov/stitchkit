---
title: "Managed agent sessions, input scheduling and run fencing"
description: "Объединить durable admission, INTERRUPT/QUEUE, settlement, shutdown и managed side-effect fencing в keyed lifecycle."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/done/2026-08-22-agent-runtime-race-probes.md
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

- [x] Зафиксировать transition/action table and linearization points.
- [x] Спроектировать submit ticket, run handle, batching and lifecycle hooks.
- [x] Добавить stable caller IDs и фактический admission receipt без зависимости consumer-а от
      store internals или порядка вызовов `generateId()`.
- [x] Реализовать execution settlement -> terminal CAS -> ownership release barrier.
- [x] Интегрировать pre-tool and pre-publication fence without breaking `mountAgent`.
- [x] Определить hung predecessor, shutdown and bounded cleanup policies.
- [x] Документировать multi-process lease/CAS and external-effect idempotency boundaries.
- [x] Прогнать deterministic race matrix.

## Acceptance

- [x] `signal.aborted` никогда не считается settlement.
- [x] Successor admission невозможен до выигравшего predecessor terminal CAS.
- [x] Superseded run не получает новое managed-tool admission или canonical publication ownership.
- [x] Уже начавшийся non-cooperative effect не объявляется отменённым/откаченным framework-ом.
- [x] Pending inputs ordered; domain merge не выдумывается framework-ом.
- [x] New, duplicate and coalesced submit возвращают одну durable identity; при coalescing receipt
      указывает существующий assigned successor, а не отброшенный proposed run.
- [x] Consumer может вернуть accepted user/assistant placeholders до terminal result, не создавая
      второй coordinator или shadow persistence path.
- [x] Hung lane behavior explicit and bounded cleanup does not falsify settlement.
- [x] Lane state не удаляется zombie cleanup-ом до actual predecessor settlement.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: input UX, debounce/queue, recovery and shutdown API.
- [x] Plan validator 2: linearizability, settlement, fencing and multi-process boundary.
- [x] Implementation validator 1: public API/runtime integration and deletion proof. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: adversarial races, hung predecessor and late effects. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.

## Consumer admission slice

- [x] `packages/core/src/agent-runtime/runtime.ts` принимает optional stable record IDs и отдаёт
      фактический assigned successor через `ticket.admission`, сохраняя `ticket.accepted`.
- [x] `packages/core/tests/agent-runtime-terminal.test.ts` — `accepts caller record ids and exposes
      the assigned admission identity` и coalescing assertions доказывают immediate placeholder и
      shared successor identity.
- [x] `docs/guide/agent-runtime.md`, `docs/api/reference.md` и `CHANGELOG.md` синхронизированы с
      additive public API.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/coordinator.ts` и `runtime.ts` связывают durable admission, ordered queue/coalescing, interrupt settlement, shutdown drain и terminal CAS.
- **Регрессия:** `packages/core/tests/agent-runtime-coordinator.test.ts::interrupt requests abort but successor waits for actual settlement`; `packages/core/tests/agent-runtime-coordinator.test.ts::force timeout bounds a non-cooperative active run and closes admission`.
- **Identity:** `packages/core/tests/agent-runtime-terminal.test.ts::returns the durable admission identity for a duplicate with discarded proposals` подтверждает new/duplicate/coalesced receipt contract.
