---
title: Agent runtime must reject empty success and preserve sequential tool rounds
description: Public runtime and history projection regressions reproduced against the published 0.68.0 package.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
---

# Agent runtime completion and history parity

## Evidence

Published `stitchkit@0.68.0`, AI SDK 7, `MockLanguageModelV3` from `ai/test`.

1. A model stream containing only `stream-start` and `finish` with unified reason
   `stop`, input usage 1 and output usage 0 produces
   `{ reason: 'success', run: { state: 'completed' }, message: { parts: [] } }` through
   `createAgentRuntime(...).submit(...).result`. A user request requiring a final
   answer thus has a successful empty terminal record. No tools or approvals involved.
   Source: `packages/core/src/agent-runtime/run-execution.ts` initializes success;
   no final-output predicate rejects the empty terminal candidate. If empty success
   is intentional for some protocols, expose a terminal acceptance policy before CAS;
   consumers must not rewrite an already committed success after the fact.

2. `projectAgentHistoryDetailed` given one user followed by a completed assistant
   whose parts are `call A → result A → call B(input uses result A) → result B → final`
   emits `assistant(call A, call B, final) → tool(result A, result B)`.
   `assistantMessages` in `agent-runtime/history.ts` buckets all assistant content
   separately from all tool results, destroying causal order. The runtime itself
   accumulates multiple steps into precisely this one-assistant parts shape, so
   this is not merely a foreign-history import issue. A final statement becomes
   earlier than the evidence it describes; dependent calls appear parallel.

## Result

- Empty model output cannot silently satisfy a protocol requiring an answer.
- Public projection preserves sequential call/result rounds and trailing final text,
  including reasoning/provider metadata and legitimate parallel calls within one round.
- Public runtime can project its own multi-step persisted output without consumer
  history rewriting or custom projector workarounds.

## Acceptance

- [x] Real AI SDK mock stream through runtime + terminal store covers empty final,
  valid final, interrupted response, tool-only policy stop, and structured/file output.
- [x] Multi-step runtime run followed by a second run verifies actual provider prompt
  ordering, not only serialized array shape.
- [x] History with dependent rounds preserves `call A → result A → call B → result B → final`.
- [x] Pack and publish corrected release; expose any new acceptance policy through
  the public API and add adoption documentation.

Priority: P1; blocks safe consumer runtime cutover. This task does not request
application-specific completion policy, storage or UI in the framework.

## Что сделано

- `defineAgentProtocol({ terminalAcceptance })` validates would-be completed
  output before terminal CAS. Exact runtime coverage:
  `packages/core/tests/agent-runtime-parity.test.ts` —
  `applies required terminal output before commit without rejecting non-success endings`,
  `terminal acceptance never rewrites an interrupted response`, and
  `publishes safe tool payloads and the name of a custom stop policy`.
- `packages/core/src/agent-runtime/history.ts` projects alternating assistant
  and tool groups in canonical part order. Exact regressions:
  `packages/core/tests/agent-runtime-history.test.ts` —
  `preserves dependent tool rounds and trailing final text in causal order`;
  `packages/core/tests/agent-runtime-parity.test.ts` —
  `projects its persisted multi-step run into the next provider prompt by causal round`.
- ADR 0123, the guide, API reference and changelog document the contract.
- Release target: `0.68.1`; immutable tag/SHA and registry integrity are
  reported from the release authorities after publication.
