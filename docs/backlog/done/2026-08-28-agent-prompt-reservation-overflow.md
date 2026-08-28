---
title: composeAgentPrompt must reject reservations exceeding context even with empty history
description: Packed 0.68.0 reports fits when output reservation alone exceeds the model window.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: P1
---

## Evidence

Reproduced against the installed stitchkit@0.68.0 package on Bun:

```ts
import { composeAgentPrompt } from 'stitchkit/agent-runtime';
const zero = { value: 0, provenance: 'computed' } as const;
await composeAgentPrompt([])({
  context: {},
  signal: new AbortController().signal,
  historyTokens: zero,
  budget: {
    contextWindow: 100,
    reservedOutput: 200,
    toolSchemas: zero,
    attachments: zero,
    providerOverhead: zero,
  },
});
```

Actual: contextDecision='fits', availableHistoryTokens=0.
Expected: oversized (the non-history reservation alone exceeds the entire window).
Compacting an empty history cannot repair this request.

## Root

packages/core/src/agent-runtime/prompt.ts clamps remaining capacity with Math.max(0,...)
before comparing historyTokens <= availableHistoryTokens. It loses the negative deficit.

## Acceptance

- [x] Keep the signed reservation deficit when deciding fit.
- [x] Reject output/instruction/tool/attachment/overhead-only overflow for empty history.
- [x] Distinguish irreducible reservation overflow from history requiring compaction.
- [x] Cover boundary equality, zero window, reject/compact policies, and unavailable counts.
- [x] Verify packed consumer import and publish the corrected package with migration notes if needed.

## Что сделано

- [x] `packages/core/src/agent-runtime/prompt.ts` retains signed history capacity;
      a negative reservation balance is always `oversized`, never `fits` or
      `requires-compaction`.
- [x] Regression: `packages/core/tests/agent-runtime-prompt-models.test.ts` —
      `reservation overflow is irreducible even with empty history` and
      `every reservation participates, equality fits, and unavailable stays unknown`.
- [x] Packed proof: `packages/core/scripts/consumer-lane/fixtures/full/src/app.ts`
      imports `composeAgentPrompt` from the tarball and asserts a `-1` deficit
      remains irreducibly oversized under compact policy.
- [x] Agent runtime guide, API reference and changelog document the corrected
      additive behavior. No migration is required. Full release verification
      and immutable `v0.68.1` registry evidence close publication.
