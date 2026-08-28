---
title: Typed per-step context refusal in agent runtime
description: Preserve context_overflow when application budgeting refuses a step before provider invocation.
type: task
status: in-progress
priority: P1
created: 2026-08-28
updated: 2026-08-28
---

## Evidence (published 0.68.3)

The initial prompt can fit while a later step exceeds the model window after tool
results or deferred schemas grow. Public loop.prepareStep allows adjusting SDK
parameters but exposes no typed context refusal. Throwing an Error is classified
as provider_failure, including when the provider was never invoked.

Minimal reproduction: createAgentRuntime with memory store, context/inputMetadata
z.object({}), a mock model, prompt.contextDecision = 'fits', and
loop.prepareStep = () => { throw new Error('Step exceeds model window'); }.
Submit one text input and await result. Observed:
`{"providerCalls":0,"reason":"provider_failure","state":"failed"}`.
Expected supported refusal: reason=context_overflow, state=failed, no provider call.
This requests a public typed refusal contract, not classification of arbitrary
Error text. Ordinary unexpected preparation errors must retain their diagnostics.

Source inspected at tag v0.68.3: packages/core/src/agent-runtime/run-execution.ts
sets contextRefusal only for initial prompt.contextDecision. The prepareStep
callback cannot set it; catch/stream error paths resolve to provider_failure.

## Required result

- [x] Public typed per-step budget/refusal primitive usable before initial and
  subsequent provider calls, without a consumer wrapper around streamText.
- [x] Durable run reason, terminal events and observability agree on context_overflow.
- [x] Deterministic regression: refusal before first provider call and after a
  tool round; zero additional provider calls; preserve completed tool evidence.
- [x] Normal unexpected callback/provider errors remain distinguishable; no
  message-string matching or consumer rewrite of terminal records.
- [ ] Release with public types, examples and versioned acceptance evidence.

Consumers can prepare adapters, but must not report provider failure for a known
application budget refusal or rewrite the committed terminal record afterward.

## Что сделано

- [x] `AgentContextOverflowError` is exported from `stitchkit/agent-runtime` and
      is the only application-side `prepareStep` failure classified as
      `context_overflow`; initial prompt refusal uses the same typed primitive.
- [x] `packages/core/tests/agent-runtime-record-agreement.test.ts` —
      `a typed step refusal agrees across result, durable state, delivery and observability`
      and `an unexpected step callback error remains provider_failure`.
- [x] `packages/core/tests/agent-runtime-parity.test.ts` —
      `a typed refusal after a tool round preserves evidence and makes no extra provider call`.
- [x] The guide, API reference, changelog and packed Bun consumer describe and
      import the public refusal contract; the packed Node runtime imports the
      same class from the published entrypoint.
- [ ] Full release gate, exact-SHA CI, tag, registry integrity and clean
      installed-package acceptance remain release evidence.
