---
title: Optional grammY application adapter
description: Add thin polling and webhook managed resources around an injected grammY bot.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23 17:39 +00:00
related: docs/backlog/done/2026-08-23-managed-application-kernel.md
---

# Optional grammY application adapter

## Зачем

Provider-driven services repeat grammY initialization, polling readiness, stop, accepted-update
drain and error projection. The bridge must delete this lifecycle glue while grammY remains the
Telegram implementation and applications retain commands, retries, durable inbox and effects.

## Результат

- `stitchkit/application/grammy` is the only entrypoint that resolves the optional grammY peer.
- Polling readiness is tied to grammY `onStart`; stop awaits the polling promise so middleware drains.
- Webhook handling has an explicit admission gate and in-flight drain around `bot.handleUpdate`.
- Error/activity facts are sanitized and contain no update payload or user identity.
- Polling and webhook are separate explicit factories, not one ambiguous mode.

## План

- [x] Define exact injected Bot ports against the current grammY peer and add it as an optional peer.
- [x] Polling starts `bot.start({ onStart })` as an immediately observed background promise, retains
      its completion, calls `bot.stop()` once, and awaits the same completion during drain.
- [x] Define pre-`onStart`, post-ready polling rejection, shutdown-during-init and `bot.stop()` failure
      semantics; late failure removes readiness and never becomes unhandled.
- [x] Webhook initializes the injected bot and exposes admission around provider-owned handling
      without parsing Telegram HTTP/update payloads or owning webhook hosting.
- [x] Preserve consumer error callbacks and explicit SDK retry plugins/policy.
- [x] Isolate throwing consumer error hooks without corrupting admission accounting.
- [x] Cover polling rejection before/after readiness, delayed middleware, repeated stop, one webhook
      admitted before shutdown and one rejected after, handler failure, concurrent stop and
      optional-peer isolation.

## Acceptance

- [x] Neutral application imports work and bundle without grammY installed.
- [x] No polling update accepted after stop-admission; accepted middleware completes before drain.
- [x] No default `drop_pending_updates`, automatic retry or durable recovery policy is introduced.
- [x] `bot.catch`, commands, middleware and retry plugins remain consumer/grammY-owned.
- [x] Another ingress resource can replace grammY without changing the kernel.

## Что сделано

### Adapter boundary

- [x] `packages/core/src/application/grammy.ts` implements separate polling and webhook managed
      resources over an injected bot; `packages/core/src/application-grammy.ts` is the isolated
      provider entrypoint.
- [x] `packages/core/package.json` declares grammY as an optional peer and exports only the dedicated
      subpath; neutral application code has no provider import.
- [x] The real-peer packed fixture lives in
      `packages/core/scripts/consumer-lane/fixtures/grammy/`; neutral and missing-peer proofs live in
      `packages/core/scripts/consumer-lane/fixtures/minimal/src/application-neutral.ts` and
      `packages/core/scripts/consumer-lane/fixtures/minimal/src/missing-grammy-peer.mjs`.

### Проверка

- [x] Регрессия: packages/core/tests/application-grammy.test.ts::polling readiness comes from onStart and shutdown awaits the retained completion; packages/core/tests/application-grammy.test.ts::polling rejection before readiness rolls back through one bot stop; packages/core/tests/application-grammy.test.ts::isolates a throwing polling error observer and reports failed stop truthfully.
- [x] Регрессия: packages/core/tests/application-grammy.test.ts::uses the force budget for retained polling completion after bot stop; packages/core/tests/application-grammy.test.ts::webhook admission drains an accepted update and rejects later updates; packages/core/tests/application-grammy.test.ts::preserves the original webhook error when a synchronous error observer throws.
- [x] Регрессия: packages/core/tests/application-grammy.test.ts::uses the force budget for accepted webhook middleware that settles after abort.
