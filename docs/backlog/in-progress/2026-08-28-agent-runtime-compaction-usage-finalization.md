---
title: Preserve compaction usage when finalizing agent runs
description: Final SDK totals overwrite tokens charged by the history compaction hook.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
---

# Preserve compaction usage when finalizing agent runs

Priority: P1. Reproduced against published stitchkit@0.68.6 on Bun 1.3.14.

## Why

The public AgentCompactionResult.usage contract states that compaction spend belongs
to the run, including multiple paid CAS attempts. A compaction hook returning
100 input / 20 output tokens plus one model step returning another 100 / 20 yields
a successful terminal run with only 100 / 20, instead of 200 / 40. This makes
durable accounting contradict the public contract. Cost is retained, while tokens
are replaced, so removing compaction usage in a consumer is not a valid fix.

Source evidence at v0.68.6:
- packages/core/src/agent-runtime/run-execution.ts:355 adds compacted.usage.
- The same file:810 invokes mergeRunTotals(normalizeSdkUsage(part.totalUsage), usage).
- runtime-internals.ts:143–161 prefers every available SDK token total to the
  accumulated value. The SDK total contains model steps only, not compaction.

Actual deterministic result: success; inputTokens=100, outputTokens=20.
The isolated reproduction below exits 1 on the input token assertion. No provider,
application adapter, database driver, credentials or network is involved.

## Result

Final run usage, terminal metrics, durable snapshots and observation agree on
model-step plus compaction spend. Provider normalization and unknown-value semantics
remain correct; SDK totals must neither discard compaction nor double count steps.

## Plan / acceptance

- [ ] Add a deterministic regression using createAgentRuntime and a nonzero compact
      hook usage result; include success and interrupted/failed paths.
- [ ] Preserve compaction token fields through terminal merge, including optional
      reasoning/cache fields and cumulative CAS retry spend.
- [ ] Keep existing normalized provider and SDK-total accounting regressions green.
- [ ] Assert persisted usage for memory and PostgreSQL stores.
- [ ] Run the full release gate and publish a patch with version, SHA and CI evidence.

## Isolated reproduction

Run this TypeScript file with Bun in an installation of stitchkit@0.68.6, ai and zod.
The hook returns not_needed with usage deliberately: the contract allows paid CAS
attempts even when no summary is committed. An applied structuredCompaction hook
reproduces the same result.

```ts
import { strict as assert } from 'node:assert';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { createAgentRuntime, createMemoryAgentRuntimeStore, defineAgentProtocol } from 'stitchkit/agent-runtime';
import { z } from 'zod';

const store = createMemoryAgentRuntimeStore();
const runtime = createAgentRuntime({
  store,
  protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}), terminalAcceptance: 'require-output' }),
  models: { resolve: () => ({
    descriptor: { provider: 'test', modelId: 'test', contextWindow: 10000, capabilities: [] },
    model: new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'Answer' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      } },
    ]) }) }),
  }) },
  prompt: () => ({ instructions: 'Answer', sections: [], instructionTokens: { value: 1, provenance: 'computed' }, contextDecision: 'fits' }),
  tools: () => ({}),
  history: { compact: async ({ conversationId }) => ({
    outcome: 'not_needed', attempts: 1, snapshot: await store.loadSnapshot(conversationId),
    usage: { inputTokens: { value: 100, provenance: 'provider-reported' }, outputTokens: { value: 20, provenance: 'provider-reported' } },
  }) },
});
try {
  const ticket = runtime.submit({ conversationId: 'usage-probe', parts: [{ type: 'text', text: 'Test' }], context: {}, metadata: {}, idempotencyKey: 'probe' });
  const result = await ticket.result;
  console.log(JSON.stringify({ reason: result.reason, expected: { inputTokens: 200, outputTokens: 40 }, actual: result.run.usage }));
  assert.equal(result.run.usage?.inputTokens.value, 200, 'Compaction tokens must survive terminal SDK totals');
  assert.equal(result.run.usage?.outputTokens.value, 40);
} finally {
  await runtime.close();
}
```
