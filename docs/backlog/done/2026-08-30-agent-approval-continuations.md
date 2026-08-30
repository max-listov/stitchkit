---
title: Agent approval continuations
description: Add recoverable allow, deny and ask authorization without replaying or renaming direct tool operations.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 04:01 +0000
pipeline: composable-agent-harness
order: 3
depends-on: 2026-08-30-failed-run-continuation-evidence.md, 2026-08-30-bounded-harness-resource-discovery.md
---

## Зачем

The provider tool protocol can request approval before a direct call, but AgentRuntime currently
rejects those message parts. UI-specific promises would lose the signed operation identity across
recovery and create a second executor beside the canonical runner.

## Результат

- The canonical runner accepts signed `tool-approval-request` and `tool-approval-response` parts
  emitted and validated by the installed AI SDK.
- A request ends one durable run. An exact allow/deny response is appended as a durable tool message
  and starts a queued successor run; recovery derives pending state from messages, not promises.
- Signature validation binds the decision to the original tool call, name and input. Stale,
  duplicate, unknown and cross-conversation responses fail closed.
- The existing tool fence still owns the actual side effect after approval. No parallel executor,
  remembered cross-run policy or cross-crash exactly-once claim is introduced.
- Existing boolean coding-tool authorization remains unchanged and independent.

## План

- [x] Extend canonical message schemas/projection with the two approval part shapes and safe fields.
- [x] Add exact pending lookup and compare-and-submit continuation on the headless harness.
- [x] Expose request/decision state through the control protocol and canonical snapshot/view work.
- [x] Cover allow, deny, signed-input validation, duplicate decisions, queued successor and memory/SQLite recovery.

## Acceptance

- [x] An exact direct tool call ends the request run before side effects and executes through its
  real typed name only in the approved successor run.
- [x] Denial is durable provider-facing evidence and does not execute the tool.
- [x] Recovery reconstructs the pending request and cannot accept the same decision twice.
- [x] Non-interactive hosts can submit the same typed decision without a control client.

## Что сделано

- Approval request/response являются canonical durable message parts; signed provider continuation
  возвращается в AI SDK, а side effect по-прежнему проходит через direct tool fence.
- `packages/core/tests/agent-harness-public.test.ts` — `continues an exact signed tool approval through
  a durable tool-role message`, `persists a denied approval as provider-facing evidence without executing the tool`,
  `reconstructs a pending approval after SQLite reopen without replaying the effect`.
