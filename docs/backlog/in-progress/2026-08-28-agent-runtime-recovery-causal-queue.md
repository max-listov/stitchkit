---
title: Recover queued runs in causal order rather than scan identifier order
description: A recovery pass reports resumed while a queued successor loses acquisition and remains stranded.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: P1
---

## Problem

Published `stitchkit@0.68.4`, Bun 1.3.14. Two durable queued runs in the same
conversation were admitted in causal order `z → a`, with distinct creation
timestamps. `scanRecoverable` returns `a → z` (its documented keyset order).
A single `runtime.recover({ resolveContext })` reports both as `resumed`.
Run `a` attempts acquisition before its predecessor and conflicts; run `z`
finishes, but `a` remains queued with no scheduled execution.

Both the memory store and an independent SQLite driver reproduce the result.
The control `a → z` finishes both runs on both stores. No restart, close,
timeout or second recovery pass occurs before the snapshot assertion.

| Admission order | Acquisition conflicts | Provider calls | Final records |
| --- | --- | --- | --- |
| a → z | none | 2 | a completed, z completed |
| z → a | a | 1 | z completed, a queued |

## Source evidence

- `packages/core/src/agent-runtime/runtime.ts`, recover loop: iterates the
  recoverable page in scan order, resumes each item, then awaits only
  `resumed.accepted`; `resumed.result` rejection is consumed.
- `packages/core/src/agent-runtime/run-execution.ts`: acquisition uses
  `appliedSnapshot(..., 'run acquisition')` before the execution terminal path.
- `packages/core/src/agent-runtime/store-driver.ts`: acquisition correctly
  refuses a queued successor while an older queued predecessor exists.

The store is enforcing causal ownership correctly. Recovery must schedule in
that order and must not strand an accepted input or misreport a dropped execution.
Do not require consumers to change identifiers, manually sort snapshots, or add
a repeated recovery polling loop to obtain ordinary FIFO progress.

## Reproduction

Run with the published package and AI SDK test helpers:

```ts
import { strict as assert } from 'node:assert';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { type AgentRuntimeStore, createMemoryAgentRuntimeStore, createAgentRuntime, defineAgentProtocol } from 'stitchkit/agent-runtime';
import { z } from 'zod';

async function probe(store: AgentRuntimeStore, backend: string, ids: string[]) {
  const conversationId = `recovery-${ids.join('-')}`;
  for (const [index, id] of ids.entries()) {
    const time = new Date(Date.UTC(2026, 7, 28, 0, 0, index)).toISOString();
    await store.acceptInputAndAssignRun({
      idempotencyKey: id,
      input: { schemaVersion: 1, id: `${id}:input`, conversationId, role: 'user', status: 'committed', parts: [{ type: 'text', text: `INPUT_${index}` }], createdAt: time, updatedAt: time },
      run: { schemaVersion: 1, id, conversationId, inputMessageIds: [`${id}:input`], assistantMessageId: `${id}:answer`, state: 'queued', revision: 0, createdAt: time, updatedAt: time },
    });
  }
  const firstTerminal = Promise.withResolvers<void>();
  const allTerminal = Promise.withResolvers<void>();
  const rejectedAcquisition = Promise.withResolvers<void>();
  let terminals = 0;
  const conflicts: string[] = [];
  const releaseProvider = Promise.withResolvers<void>();
  const calls: unknown[] = [];
  const runtime = createAgentRuntime({
    store: { ...store, async acquireRun(input) {
      const result = await store.acquireRun(input);
      if (result.outcome === 'conflict') { conflicts.push(input.runId); rejectedAcquisition.resolve(); }
      return result;
    } },
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}), terminalAcceptance: 'require-output' }),
    models: { resolve: () => ({ descriptor: { provider: 'test', modelId: 'test', contextWindow: 10000, capabilities: [] }, model: new MockLanguageModelV3({ doStream: async options => {
      calls.push(options.prompt);
      await releaseProvider.promise;
      return { stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Answer' }, { type: 'text-end', id: 'text' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
      ]) };
    } }) }) },
    prompt: () => ({ instructions: 'Answer', sections: [], instructionTokens: { value: 1, provenance: 'computed' }, contextDecision: 'fits' }),
    tools: () => ({}),
    publish(event) { if (event.type === 'terminal') { terminals++; firstTerminal.resolve(); if (terminals === ids.length) allTerminal.resolve(); } },
  });
  const timeout = setTimeout(() => firstTerminal.reject(new Error('No recovered run reached a terminal event')), 3000);
  try {
    const outcomes = await runtime.recover({ resolveContext: () => ({}) });
    releaseProvider.resolve();
    await firstTerminal.promise;
    await Promise.race([allTerminal.promise, rejectedAcquisition.promise]);
    const snapshot = await store.loadSnapshot(conversationId);
    const result = { backend, ids, outcomes, conflicts, calls: calls.length, runs: snapshot.runs.map(run => ({ id: run.id, state: run.state, reason: run.terminalReason })) };
    console.log(JSON.stringify(result));
    return snapshot.runs.every(run => run.state === 'completed');
  } finally { clearTimeout(timeout); releaseProvider.resolve(); await runtime.close(); }
}

const results = [];
for (const ids of [['a', 'z'], ['z', 'a']]) results.push(await probe(createMemoryAgentRuntimeStore(), 'memory', ids));
assert.ok(results.every(Boolean), 'A recovery pass must preserve causal queue order');
```

The asynchronous provider barrier ensures the recovery scan finishes before the
first answer. The positive case proves that the terminal-event wait can complete.
The negative case awaits an observed acquisition conflict and the actual terminal
event of the predecessor; it does not infer failure from a short empty poll.

## Acceptance

- [x] One recovery pass schedules all queued predecessors/successors in causal order,
      independent of identifier order, same-timestamp ties and page boundaries.
- [x] No successor input leaks into the predecessor prompt.
- [x] Recovered results and errors are observable; no false successful handoff
      leaves a run queued without further progress.
- [x] Cover acquired/stale predecessors, replay-safety policy, cancellation,
      concurrent admission/recovery and close without duplicating side effects.
- [x] Deterministic regression on the memory store and PostgreSQL conformance.
- [ ] Publish a patch with clean verification and package-install proof.

## Что сделано

- [x] `packages/core/src/agent-runtime/runtime.ts` buffers only the bounded recovery
      window, groups it by conversation and schedules each group in the store's
      canonical causal order; an unscheduled predecessor keeps its successors skipped.
- [x] `runtime.resume().accepted` now settles only after durable acquisition, and
      `AgentRuntimeRecoveryOutcome.result` exposes terminal completion or failure.
- [x] `packages/core/src/agent-runtime/store-driver.ts` derives active-run order from
      durable history, including same-timestamp ties; the reusable conformance kit
      requires the same order from every production adapter.
- [x] `packages/core/tests/agent-runtime-queue-isolation.test.ts` —
      `queued inputs cross the provider boundary only with their assigned run > recovery restores causal order across pages with distinct timestamps`
      and the matching `equal timestamps` case prove `z → a` order, prompt isolation,
      terminal completion and `pageSize: 1` on the memory store.
- [x] `packages/core/tests/agent-runtime-store-driver.test.ts` —
      `agent runtime store driver > reports an acquisition conflict as failed instead of a successful handoff`,
      `bounded recovery resumes queued work and skips a live acquired run by default`
      and `does not resume a queued successor while an acquired predecessor is unresolved`
      pin result observability and predecessor policy.
- [x] `packages/core/tests/agent-runtime-store-driver.test.ts` —
      `agent runtime store driver > memory driver passes the reusable production-store contract`
      and `examples/agent-store-prisma/adapter.test.ts` —
      `Prisma/PostgreSQL agent store reference > passes the reusable store conformance contract`
      prove the active-order contract on memory and real PostgreSQL drivers.
- [x] Full `bun run verify` passed for tree `02992105a45e`.
