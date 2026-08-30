---
title: Preserve failed mounted tools as failed durable Agent outcomes
description: Do not classify formatted tool error envelopes as successful execution in AgentRuntime.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P1
---

## Reproduction

Published stitchkit 0.69.0, ai 7.0.77, Bun 1.3.14. Compose createHeadlessAgentHarness with
createAgentCodingTools mounted through mountAgent and the canonical toolFenceLifecycle.
Write a file with `amber`, read its digest, apply a valid patch to `blue`. Request another
apply_patch with the old digest. The file remains `blue` and the stale mutation is refused.
Nevertheless the canonical assistant records:

```json
{"type":"tool-result","callId":"file-4","toolName":"apply_patch","outcome":"success","output":{"error":"INTERNAL_SERVER_ERROR","details":{"message":"Internal server error"}}}
```

Expected durable outcome is error, not success. The failure reproduces with a deterministic
AI SDK model emitting real direct tool calls; file effects are independently checked on disk.

## Mechanism

`packages/core/src/tools/agent.ts`: mountAgent resolves formatToolError after a failed runner
instead of preserving typed failure to the SDK. `packages/core/src/agent-runtime/run-execution.ts`
therefore receives a tool-result and unconditionally records success. There is no consumer
configuration in AgentMountConfig to preserve this error channel. This is not a request for
consumers to heuristically inspect output.error: valid business data may contain such fields.

## Acceptance

- [ ] Preserve typed mounted-tool failures through AI SDK, fenced execution and canonical persistence.
- [ ] Live tool events, checkpoints, replay and model-facing continuation agree on the failure.
- [ ] Valid successful tool data containing an error key is not misclassified.
- [ ] Expected stale-patch/authorization refusals retain useful typed safe semantics; private causes stay private.
- [ ] Tests cover direct coding tools, ordinary mounted runtime tools, cancellation and SQLite reopen.
- [ ] Publish a corrected package with exact version and public-consumer evidence.
