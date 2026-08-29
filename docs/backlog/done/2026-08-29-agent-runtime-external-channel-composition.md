---
title: Agent runtime external-channel composition
description: Prove a reusable ingress and delivery boundary for webhooks, polling channels and local adapters while keeping identity and durable delivery application-owned.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
---

## Зачем

An external channel has two independent lifecycles: accepting an inbound update into an agent
conversation and delivering agent output back to the channel. Stitchkit ships the agent runtime,
durable runtime event identities, bounded in-process channels and grammY lifecycle resources, but
there is no executable reference that composes them without confusing a successful agent run with
a successfully delivered reply.

A generic proof is needed for webhook, long-polling and local device adapters. Channel identity,
conversation mapping, payload storage, delivery retry and provider acknowledgements remain
application policy. The framework must not introduce a Telegram-specific conversation model or a
second durable message bus.

## Результат

- A headless channel harness demonstrates inbound deduplication, application-owned
  channel-to-conversation mapping, agent admission and ordered output delivery using public
  Stitchkit primitives.
- Runtime completion and channel delivery are represented as separate outcomes. A terminal agent
  result is never treated as a delivery receipt.
- The application owns durable inbox/outbox records and classifies delivery as not dispatched,
  possibly dispatched or acknowledged. Stitchkit supplies stable event identity and lifecycle
  composition, not a provider-specific outbox database.
- A generic injected adapter is the primary example; an isolated grammY composition proves that
  the optional provider resource can use the same boundary without leaking provider types into
  the agent runtime.
- If a small reusable framework seam is missing, it is added only after reproduction against the
  published package. No channel registry, durable broker or product conversation schema is added.

## План

- [x] Audit `createAgentRuntime`, runtime event cursors and durable event IDs,
  `createBoundedChannel`, application resources and the grammY polling/webhook adapters using
  the published package.
- [x] Define a generic fixture channel with application-owned inbound update ID, principal,
  conversation binding, reply target and delivery receipt. Keep authorization and identity
  resolution outside framework schemas.
- [x] Demonstrate atomic application admission of one inbound update before agent submission;
  duplicate webhook or polling delivery must resolve to one runtime input/run assignment.
- [x] Project reasoning/tool/text/terminal events in causal order while applying an explicit
  channel policy for partial streaming versus terminal-only replies.
- [x] Demonstrate delivery recovery across restart. Not-dispatched may retry; possibly-dispatched
  requires provider reconciliation or remains unresolved; acknowledged delivery deduplicates.
- [x] Verify that delivery failure, provider unavailability and application shutdown do not mutate
  the canonical agent terminal result or leave an invisible active run.
- [x] Compose the same harness once with an injected generic adapter and once with the isolated
  grammY managed resource. Webhook parsing and provider payload persistence remain outside
  Stitchkit.
- [x] Add packed Bun and Node checks, lifecycle/error regressions and guide/API/LLM documentation.
  Introduce a public helper only if the existing primitives require repeated unsafe glue that the
  fixture can reproduce.

## Acceptance

- [x] Duplicate inbound updates create one admitted agent input and preserve one stable mapping
  after restart.
- [x] Reasoning, tool calls, text and terminal delivery keep causal order under the declared
  channel policy without an unbounded in-memory queue.
- [x] Agent success and reply delivery success remain distinct in state, diagnostics and recovery.
- [x] A post-dispatch timeout never authorizes a blind resend; a provider acknowledgement closes
  the application-owned delivery record idempotently.
- [x] One generic adapter and the optional grammY adapter pass the same composition scenarios
  without provider-specific types in core agent APIs.
- [x] Shutdown stops ingress, drains accepted process-local work within bounds and leaves durable
  unresolved delivery visible for later recovery.
- [x] No durable broker, channel database, Telegram conversation model or application identity
  policy moves into Stitchkit.
- [x] Full repository verification and packed consumer gates pass if implementation changes are
  required; documentation-only completion records the executable checks that proved sufficiency.

## Что сделано

- Added a provider-neutral headless ingress/outbox harness with durable update deduplication,
  stable conversation/run mapping, explicit streaming policy and causal event identities.
- Made runtime terminal state and delivery acknowledgement separate. Durable outbox states are
  `not-dispatched`, `possibly-dispatched` and `acknowledged`; ambiguous dispatch is reconciled and
  never blindly resent.
- Added isolated grammY polling/webhook composition over the same ingress boundary, bounded wakeup
  delivery, managed shutdown, packed Bun/Node execution and generated guide/LLM documentation.
- `bun run verify` passed for tree `3cc967e117b8`.

## Регрессия

- `packages/core/tests/external-channel-harness.test.ts` —
  `duplicate ingress keeps one run mapping across a harness restart`.
- `packages/core/tests/external-channel-harness.test.ts` —
  `terminal delivery receipt is separate and ambiguous dispatch reconciles without resend`.
- `packages/core/tests/external-channel-harness.test.ts` —
  `streaming policy preserves reasoning tool text and terminal causal order`.
