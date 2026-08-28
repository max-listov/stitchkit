---
title: Durable interrupt priority ahead of pending ordinary runs
description: Provide a public policy for urgent interrupt input to run next without dropping previously queued input.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 11:58 +0000
---

## Why

A consumer with queue and interrupt delivery modes cannot replace its own queue
with the runtime coordinator while preserving this existing behavior:
A is running, B is waiting, urgent C interrupts A and executes before B.
B must remain queued and execute afterwards.

This is a missing priority policy, not a claim that the documented FIFO default
is incorrect. An explicit opt-in public policy is acceptable; keep ordinary FIFO.

## Evidence on published 0.68.5

Source tag v0.68.5, commit be704cf5ea632f741bb06eeb3c10a6634c61dd4f:
packages/core/src/agent-runtime/coordinator.ts aborts the active controller for
interrupt and then always calls lane.queue.push(pending). The runtime durable
admission/acquisition also maintains causal order, so a consumer-side array
unshift alone would not be a valid fix.

Deterministic runtime probe using MockLanguageModelV3, createAgentRuntime and
both createMemoryAgentRuntimeStore and createAgentRuntimeStore SQL driver:

| Policy of C | Execution order | A terminal | B/C terminal |
| --- | --- | --- | --- |
| queue | A, B, C | success | success |
| interrupt | A, B, C | interrupted | success |
| required opt-in priority | A, C, B | interrupted | success |

The probe waits for A's provider to start, durably admits B, admits C, observes
A's abort signal, releases the provider barrier and awaits all three terminal
results before closing the runtime. This is not a timing or shutdown artifact.

Minimal coordinator reproducer (Bun, stitchkit@0.68.5):

```ts
import { strict as assert } from 'node:assert';
import { createAgentSessionCoordinator } from 'stitchkit/agent-runtime';

const coordinator = createAgentSessionCoordinator();
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const aborted = Promise.withResolvers<void>();
const order: string[] = [];
const first = coordinator.submit({
  key: 'conversation',
  policy: 'queue',
  create: (signal) => ({
    runId: 'A',
    async execute() {
      order.push('A');
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
    },
  }),
});
await entered.promise;
const second = coordinator.submit({
  key: 'conversation', policy: 'queue',
  create: () => ({ runId: 'B', async execute() { order.push('B'); } }),
});
const urgent = coordinator.submit({
  key: 'conversation', policy: 'interrupt',
  create: () => ({ runId: 'C', async execute() { order.push('C'); } }),
});
await aborted.promise;
release.resolve();
await Promise.all([first.result, second.result, urgent.result]);
await coordinator.close();
console.log(order); // A, B, C
assert.deepEqual(order, ['A', 'C', 'B']); // required priority policy
```

## Required result

- [x] Public opt-in interrupt-next policy across coordinator and durable runtime.
- [x] Wait for real settlement of interrupted A before C acquires.
- [x] Preserve B's identity, input, idempotency and eventual execution; no dropping,
  re-admission or replay of already completed side effects.
- [x] Canonical prompts/history follow effective execution order: C must not answer
  an ordinary pending B early, and B must see C's completed turn when it executes.
- [x] Persist the effective pending order so recovery after a restart preserves it,
  including same timestamps and scan page boundaries.
- [x] Deterministic coordinator/runtime regressions and memory/PostgreSQL public
  store conformance; packed consumer proof for the exposed policy.
- [x] Document semantics and publish a verified release with exact version/SHA.

No consumer queue wrapper, private storage mutation or private dist import is an
acceptable implementation.

## Что сделано

- `interrupt-next` added to `AgentInputPolicy`; the coordinator keeps two FIFO
  pending classes and never starts the priority run before the active run has
  actually settled.
- Runtime admissions persist `queuePriority`, bypass ordinary coalescing for an
  urgent input, and assign immutable `executionSequence` only on the winning
  acquisition CAS. Snapshot, active-read and recovery ordering use those facts.
- Canonical history and prompts follow effective execution order: urgent C is
  isolated from pending B, while B later sees C and its completed answer.
- ADR 0127, the agent-runtime guide and API reference describe the opt-in policy,
  persistence boundary and compatibility behavior.
- Exact regressions: `packages/core/tests/agent-runtime-coordinator.test.ts` —
  `interrupt-next settles the active run then precedes ordinary pending work`
  and `interrupt-next preserves FIFO among urgent submissions`;
  `packages/core/tests/agent-runtime-interrupt-priority.test.ts` — all three
  `durable interrupt-next priority` cases.
- Memory and PostgreSQL adapters run the new scenario through
  `packages/core/src/testing/agent-store-conformance.ts`; the packed Node and
  full consumer fixtures execute the exported conformance kit from the built
  tarball. Targeted suite: 31 passed; PostgreSQL lane: 7 passed; packed consumer
  lane: minimal, NodeNext, full, Node and grammY all passed.
- Released as `stitchkit@0.68.6` from exact SHA
  `85c4c54add60dc5d97908fbeca0fb12c9466632e`; exact-SHA CI run `33168932687`
  and release run `33169137794` passed. npm integrity is
  `sha512-fnniuyge5JEN55TVdI3qH+nN1XyGJ6MglwOraWeOk6FkYs7mv6ZZyEo1kkFVT1bcsYj4HZW7KJCiKwnsjDoyfw==`;
  clean Bun and Node imports of the published priority schema passed.
