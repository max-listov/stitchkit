---
title: "Optional agent application runtime for Stitchkit"
description: "Зонтичная задача: один optional runtime вместо скопированных conversation, model, loop, session и telemetry engines."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-capability-audit.md
  - docs/backlog/done/2026-08-22-agent-runtime-product-contract.md
  - docs/backlog/done/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/done/2026-08-22-agent-durable-run-store.md
  - docs/backlog/done/2026-08-22-agent-prompt-context-runtime.md
  - docs/backlog/done/2026-08-22-agent-history-compaction.md
  - docs/backlog/done/2026-08-22-agent-model-provider-registry.md
  - docs/backlog/done/2026-08-22-agent-loop-and-stream-runtime.md
  - docs/backlog/done/2026-08-22-agent-managed-tool-runtime.md
  - docs/backlog/done/2026-08-22-agent-runtime-delivery-events.md
  - docs/backlog/done/2026-08-22-agent-session-coordination.md
  - docs/backlog/done/2026-08-22-agent-runtime-observability.md
  - docs/backlog/done/2026-08-22-agent-runtime-race-probes.md
  - docs/backlog/done/2026-08-22-agent-runtime-package.md
  - docs/backlog/done/2026-08-22-agent-runtime-consumer-parity.md
---

# Optional agent application runtime for Stitchkit

## Зачем

Несколько applications независимо содержат одинаковые message/history mechanics, prompt assembly,
compaction, language-model adapters, AI SDK stream loop, checkpoints, keyed run lifecycle и usage
telemetry. Domain prompts, tools, persistence и delivery различаются, но engine снова портируется.

Stitchkit должен дать optional opinionated `stitchkit/agent-runtime`. Новый consumer описывает
protocol schemas, store adapter, domain prompt/tools, allowed models и delivery adapter вместо
собственного runtime. Low-level `mountAgent` остаётся полноценным независимым путем.

## Product boundary

Framework владеет versioned internal engine protocol, provider-valid history, durable run-store
operations, prompt/context mechanics, compaction execution, language-model registry mechanics,
stream loop, managed-tool fencing, run state machine, neutral application events, telemetry и
deterministic probes.

Consumer владеет domain content/tools/auth, model allowlist/default policy, ORM schema, object
storage, transport presentation, business-effect idempotency, UI и distributed lease implementation.
Runtime — explicit instance без hidden module-global ownership. Это не generic durable job queue.

## Предпочтительная форма

```ts
const runtime = createAgentRuntime({
  protocol,
  store,
  models: { resolve },
  prompt,
  tools,
  history: { compaction },
  runs: { key, inputPolicy: 'interrupt' },
  publish,
  observe,
})

const ticket = runtime.submit(input)
await ticket.accepted
await ticket.result
```

Input становится durable до scheduling. `accepted` отделён от terminal `result`. Stable runtime
events отделены и от AI SDK union, и от operator observability.

## Результат

- Один coherent optional entrypoint покрывает application-level agent runtime, сохраняя low-level
  tool surface независимым.
- Standard consumer больше не содержит собственные loop/session/compaction/provider mechanics.
- Durable state, managed effects, delivery and observability имеют разные typed boundaries и
  честные guarantees.
- First release должен быть доказан двумя structurally different integration shapes без раскрытия
  consumers в public repository.

## План

- [x] Evidence audit.
- [x] `VISION.md`, ADR, ownership и state contracts.
- [x] Internal protocol, aggregate durable store, model adapter, stream loop и application events.
- [x] Coordination и managed-tool fencing вместе с deterministic barrier/trace primitives.
- [x] Prompt/context, CAS-compaction и observability.
- [x] Coherent public entrypoint только после всех обязательных zones; полуготовые modules остаются
   internal.
- [x] Выполнить packed Bun/Node package proof.
- [x] Создать отдельные consumer-owned migration tasks через packed release
   candidate.

## Оценка

- Предварительно production runtime/adapters: 8–12k строк.
- Deterministic tests/conformance/race probes: 5–8k.
- Packed fixtures, ADR и docs: 2–3k.
- Gross addition: 15–23k; audit уточняет estimate. Greenfield wiring: 250–600 плюс 150–350 строк
  store adapter.
- Реалистичное удаление в нескольких зрелых consumers: 5.7–8.7k generic runtime glue.

Фактический первый authored slice сейчас — около 3.1k строк runtime, tests и
packed-fixture code, плюс public docs/backlog. Это ещё не validated release LOC:
production database adapters остаются consumer-owned, а migration deletion proof ещё не выполнен.

## Acceptance

- [x] Greenfield fixture не содержит собственного loop, session coordinator, compactor или provider
  adapter для поддерживаемого пути.
- [x] Consumer code ограничен typed adapters/config и domain prompt/tools/delivery; ORM и transport не
  протекают в core.
- [x] Existing `mountAgent` остаётся usable без runtime migration.
- [x] Каждый public slice coherent; rejected capabilities зафиксированы evidence, не пустым API.
- [x] Public artifacts не раскрывают private consumers.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: product boundary, composition API, consumer deletion и scope completeness.
- [x] Plan validator 2: state ownership, persistence/fencing, packaging и release risk.
- [x] Implementation validator 1: public API/types/docs и greenfield ergonomics. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: races, durability boundaries и packed Bun/Node behavior. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.

Implementation идёт по явно выбранному конвейеру 0/0: implementation validators не запускались.

## Проверено

- `bun run verify` проходит через полный framework, packed consumer и starter matrix.
- `packages/core/scripts/consumer-lane/fixtures/full/src/app.ts` и
  `agent-runtime-neutral.ts` используют только public entrypoints; Node smoke импортирует neutral и
  isolated provider entrypoints раздельно.
- Controlled deletion proof выполнен; отдельные implementation validators не запускались по явно выбранному конвейеру 0/0.


## Что сделано

- **Coherent runtime:** public `stitchkit/agent-runtime` теперь объединяет protocol, durable reducer/store, history, prompt/context, compaction, model registry, loop, coordinator, managed tools, delivery и observability.
- **Architecture:** ownership/state/linearization contracts синхронизированы в `docs/architecture/agent-runtime.md`, ADR 0098, VISION, guide, API reference и CHANGELOG.
- **Proof:** `bun run verify` полностью зелёный; PostgreSQL/Prisma proof 6/6; controlled deletion proof net −635. Release/deploy являются отдельным явно исключённым scope.
