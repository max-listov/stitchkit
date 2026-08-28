---
title: Agent runtime must isolate queued successor inputs from predecessor prompts
description: Deterministic queue-policy repro against published 0.68.1 leaks a later input into an earlier run and misorders turn history.
type: task
status: in-progress
priority: P1
created: 2026-08-28
updated: 2026-08-28
---

# Queued input isolation

## Evidence

Published stitchkit 0.68.1, ai 7.0.77, Bun 1.3.14. Reproduced with both
createMemoryAgentRuntimeStore and a durable SQLite AgentRuntimeStoreDriver.
The earlier empty-final and sequential-tool-round fixes pass. This is a new,
independent boundary and blocks adoption of the runtime queue.

Use one runtime with runs.inputPolicy = 'queue'. Wrap only store.acquireRun
with an async barrier for its first invocation (before delegating to the real
store). This models normal async acquisition latency; no records are corrupted
and no store result is changed.

1. Submit first input FIRST_INPUT; wait until its acquireRun reaches the barrier.
2. Submit second input SECOND_QUEUED_INPUT; await second.accepted.
3. Release acquisition, await both results, capture MockLanguageModelV3.doStream
   options.prompt for each execution.
4. Both runs complete. First run.inputMessageIds contains ONLY the first input.
   Nevertheless the first provider prompt contains BOTH user inputs.
5. Second provider prompt is FIRST_INPUT, SECOND_QUEUED_INPUT, first assistant.
   The second input is earlier than the previous answer instead of following it.

Actual first prompt (system omitted):
```json
[{"role":"user","content":[{"type":"text","text":"FIRST_INPUT"}]},{"role":"user","content":[{"type":"text","text":"SECOND_QUEUED_INPUT"}]}]
```
Expected: first prompt contains FIRST_INPUT only. Second prompt has the completed
first turn followed by SECOND_QUEUED_INPUT. A queued input must not be answered
by a predecessor that never owns or absorbs it.

## Minimal scheduling harness

```ts
const durable = createMemoryAgentRuntimeStore();
const acquiring = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let firstAcquisition = true;
const store = {
  ...durable,
  async acquireRun(input: Parameters<typeof durable.acquireRun>[0]) {
    if (firstAcquisition) {
      firstAcquisition = false;
      acquiring.resolve();
      await release.promise;
    }
    return durable.acquireRun(input);
  },
};
// runtime: store above, queue policy, ordinary nonempty MockLanguageModelV3
// answer (text-start, text-delta, text-end, finish/stop); capture options.prompt.
const first = runtime.submit({conversationId:'queue', idempotencyKey:'first', context:{}, parts:[{type:'text',text:'FIRST_INPUT'}]});
await acquiring.promise;
const second = runtime.submit({conversationId:'queue', idempotencyKey:'second', context:{}, parts:[{type:'text',text:'SECOND_QUEUED_INPUT'}]});
await second.accepted;
release.resolve();
const results = await Promise.all([first.result, second.result]);
assert.equal(JSON.stringify(prompts[0]).includes('SECOND_QUEUED_INPUT'), false);
```

## Mechanism inspected

packages/core/src/agent-runtime/run-execution.ts acquires a run, checkpoints its
assistant and projects snapshot.messages wholesale. That snapshot can already
contain later admissions. projectAgentHistoryDetailed receives no assigned-run
boundary, and committed user messages always project. The snapshot contains
conversation history, not the current run's eligible input set.

Canonical append order also places later user admissions before the earlier
assistant draft, so queue turn grouping/structuredCompaction needs a regression
alongside the prompt fix. Do not solve this by filtering data in a consumer
history adapter or by restoring a second application-owned queue.

## Plan

- [ ] Encode the concurrent queue-admission repro at the public runtime boundary.
- [ ] Derive the prompt/history eligibility boundary from durable run ownership rather than
      projecting every message already present in the conversation snapshot.
- [ ] Preserve successor turn order, coalesced/injected inputs, recovery and compaction semantics.
- [ ] Prove the fix against the memory store and the public durable-driver conformance boundary.
- [ ] Update public guidance and release metadata, pass the complete release gate, rescan the live
      backlog and publish the corrected package.

## Acceptance

- [ ] Public runtime + mock provider regression proves assigned-input isolation
  during concurrent queue admissions and async acquisition/checkpoint boundaries.
- [ ] Successor prompt contains the prior completed turn then its own assigned
  inputs, preserving legitimate coalesced/injected inputs without duplication.
- [ ] Verify causal history/structured compaction after concurrent queue admissions.
- [ ] Verify memory and public durable-driver implementations; preserve admission
  idempotency, interrupt/supersede/recovery semantics and legitimate injection.
- [ ] Publish a corrected package with the regression and adoption note.

Consumer remains on its existing execution path pending a corrected release;
no consumer queue filter or runtime fork was added.
