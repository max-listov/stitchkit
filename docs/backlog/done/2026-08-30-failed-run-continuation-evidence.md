---
title: Safe continuation evidence from failed terminal agent runs
description: Preserve completed tool evidence and partial findings without claiming failed runs succeeded or replaying effects.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 04:01 +0000
pipeline: composable-agent-harness
order: 1
depends-on: —
---

## Problem

In 0.68.8, projectAgentHistoryDetailed omits assistant records with status failed.
Canonical source packages/core/src/agent-runtime/history.ts also excludes failed via
isSpeakableAssistantStatus and draft-or-failed projection. A run that completed tools
and produced a finding before provider timeout or process abandonment loses all of
that context on the next user continuation. Persisted history remains intact.

## Reproduction

Commit user request, assistant text finding and matching successful tool-call/result.
Fail the run with timeout (also test abandoned/provider error). Append user continuation.
Project canonical history: prior assistant findings and successful tool results disappear.
No summary/archival is required to reproduce.

## Required result

- [x] Provide one explicit history-evidence policy shared by projection, context budgeting and
  compaction. The compatibility default continues to omit failed assistant records.
- [x] Preserve only provider-valid completed tool rounds and eligible text with a non-success marker;
  unmatched calls fail closed through the existing chronology check.
- [x] Preserve original persisted status, run causality and idempotency; never replay tools.
- [x] Incomplete tool chronology is omitted; private terminal diagnostics are not injected.
- [x] Regression coverage proves default omission, explicit marked evidence, incomplete tool
  omission, and agreement across projection, compaction and context budgeting. Terminal reasons
  that map to status `failed` share this policy; `interrupted` retains its existing separate policy.
- [x] Publish supported API and release-ready evidence; consumers must not cast failed to completed.

## Scope

Framework history/projection API only. Not an application recovery loop or automatic
retry policy. Existing interruptedAssistant behavior and successful history stay compatible.

## Что сделано

- `AgentHistoryEvidencePolicy` стал одним policy для projection, budget и compaction; default
  по-прежнему omits failed assistants, opt-in добавляет явный failure marker без изменения durable status.
- `packages/core/tests/agent-runtime-history.test.ts` — `opts failed terminal evidence in with an
  explicit non-success marker`, `fails closed when opted-in failed evidence has incomplete tool chronology`.
- `packages/core/tests/agent-harness-public.test.ts` — `continues an exact signed tool approval
  through a durable tool-role message` доказывает compaction whole-turn chronology; `packages/core/tests/agent-runtime-prompt-models.test.ts`
  — `evicts a completed approval continuation as one chronological turn` доказывает budget agreement.
