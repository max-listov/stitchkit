---
title: Preserve failed mounted tools as failed durable Agent outcomes
description: Do not classify formatted tool error envelopes as successful execution in AgentRuntime.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 11:31 +00:00
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

- [x] Preserve typed mounted-tool failures through AI SDK, fenced execution and canonical persistence.
- [x] Live tool events, checkpoints, replay and model-facing continuation agree on the failure.
- [x] Valid successful tool data containing an error key is not misclassified.
- [x] Expected stale-patch/authorization refusals retain useful typed safe semantics; private causes stay private.
- [x] Tests cover direct coding tools, ordinary mounted runtime tools, cancellation and SQLite reopen.
- [x] Publish a corrected package with exact version and public-consumer evidence.

## Что сделано

- `packages/core/src/tools/agent-tool-error.ts` carries the safe public envelope through the AI SDK
  error channel while retaining the private cause internally; `mountAgent` rejects failed runners.
- `packages/core/src/agent-runtime/run-execution.ts` persists and publishes that envelope with
  `outcome: error`; unknown failures stay generic. Coding authorization and stale-patch refusals
  retain `FORBIDDEN` and `CONFLICT`.
- `packages/core/tests/agent-runtime-mounted-tool-errors.test.ts`, cases `persists one typed failure,
  publishes it and continues the model after SQLite reopen` and `does not infer failure from
  successful business data named error`, cover events, checkpoint/history, replay, continuation and
  the success counterexample. Direct mount/coding/runtime error suites remain green.
- Full `bun run verify` passed on tree `e23094e6b7f3`; exact-SHA CI run `33308956173` passed.
- Published as `stitchkit@0.70.0`, source
  `d2478418469ae8ebb8dfce195e621c637422d178`, integrity
  `sha512-2aVY8ZlqVqRnw6tmJkavFRgFQJ2Qq+IZqygFwCqgyksD7232jQEZmoJ7r8dZBDL/XS55Nc1ftKAQdbH3WldNVQ==`.

Completed: 2026-08-30 11:31 +0000
