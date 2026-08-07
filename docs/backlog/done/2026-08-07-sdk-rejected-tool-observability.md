---
title: Observe MCP tool calls rejected before the handler
description: Add an audit hook for SDK-level argument rejection when the MCP SDK exposes a stable public interception seam.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 07:43 +00:00
related: docs/backlog/done/2026-08-07-framework-owned-native-mcp-registration.md
---

# Observe MCP tool calls rejected before the handler

## Useful gap

Invalid MCP arguments can be rejected by the SDK with `InvalidParams` before a
stitchkit handler starts. Lifecycle and normal tool hooks correctly do not claim
that a handler ran, but security/audit consumers cannot observe the rejected
attempt through stitchkit.

A future dedicated hook could report the tool name, protocol error code,
validation issues and request context without pretending it is an
`afterToolCall` event.

## Why frozen

The current SDK performs this validation before the registered callback and
does not expose a stable public rejection observer at that boundary. Capturing
it now would require replacing or reaching into the SDK's tools/call dispatcher,
which violates stitchkit's thin-wrapper boundary and creates a fragile second
protocol implementation.

## Defrost plan

When the upstream interception seam exists:

1. Confirm it runs for schema rejection but not for transport/parser failures.
2. Design a separate `onToolRejected` options object and record its event model.
3. Preserve request identity without creating a fake tool-call lifecycle.
4. Add audit, concurrency, redaction and error-normalization tests.
5. Document the precise ordering relative to SDK validation and normal hooks.

Until then, document this observability boundary honestly and do not monkey-patch
or replace the SDK dispatcher.

## Что сделано

- [x] **The pre-callback boundary was removed instead of intercepted** — MCP now
      uses a public identity carrier that advertises JSON Schema metadata but
      forwards raw arguments into Stitchkit.
- [x] **Invalid input is observable** — original contract/native validation runs
      inside `executeToolMethod`, so `beforeToolCall` and `afterToolCall` fire and
      audit consumers receive the normal `VALIDATION_ERROR` result.
- [x] **No dispatcher replacement or rejection hook added** — the root fix lives
      in `packages/core/src/tools/mcp.ts` and ADR 0050.
- [x] **Regression covered** — contract and native strict failures are exercised
      in `packages/core/tests/advertised-key-policy.test.ts` and
      `packages/core/tests/native-mcp-registration.test.ts`.
