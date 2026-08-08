---
title: Async and endpoint-aware createErrorHook
description: Let the framework error helper perform asynchronous attribution and rendering without forcing consumers to rebuild normalization
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 01:42 +00:00
---

# Async and endpoint-aware `createErrorHook`

## Problem

`LifecycleHooks.onError` already supports an async response and receives the
matched `MethodDef`. The higher-level `createErrorHook`, however:

- declares `onError` as synchronous;
- does not pass the endpoint to the observer;
- invokes `render` synchronously;
- returns before an asynchronous identity/audit enrichment step could finish.

A consumer that must resolve request identity after pre-handler failures cannot
use the helper. It has to duplicate framework error classification, code
mapping, safe-message behavior, response serialization and status selection
just to await one attribution step.

## Desired API

Keep one helper and widen its callbacks rather than adding a parallel async
variant:

```ts
createErrorHook({
  codeMap,
  onError: async (error, info, ctx, endpoint) => {
    await attributeFailure(ctx, endpoint)
  },
  render: async (info, ctx, endpoint) => ({
    error: { code: info.code },
    traceId: ctx.traceId,
  }),
})
```

Synchronous callbacks remain naturally assignable to the widened signatures;
there is no alias, wrapper or second helper.

## Plan

- [x] Extend `ErrorHookConfig.onError` to accept synchronous or asynchronous
  observers (their return value is ignored) and
  receive `endpoint?: MethodDef` as its fourth argument.
- [x] Extend `render` to return `unknown | Promise<unknown>` and receive the same
  optional endpoint.
- [x] Make the generated lifecycle hook async; normalize once, await the
  observer, await rendering, then serialize the final JSON response.
- [x] Preserve ordering: normalization → consumer observer/enrichment → render →
  response. Rendering must see any context enrichment made by the observer.
- [x] Preserve the existing safe normalization contract for Zod, framework,
  branded application and unexpected errors.
- [x] Verify failures thrown by observer/render flow into the existing outer
  error-hook failure guard without recursively invoking the hook or leaking the
  original error.
- [x] Cover matched endpoints and router/pre-match failures where `endpoint` is
  intentionally `undefined`.
- [x] Update the auth/errors and observability guides, API reference, generated
  LLM docs and `[Unreleased]` changelog.

## Tests

- [x] A synchronous one-argument renderer remains valid and behaves unchanged.
- [x] An async observer is awaited before render and may enrich `ctx`.
- [x] An async renderer is awaited and produces the configured JSON envelope.
- [x] The exact matched `MethodDef` reaches both callbacks.
- [x] A route-level error without a matched method passes `undefined` endpoint.
- [x] Observer/render rejection is handled by the outer hook-failure path.
- [x] Status, code mapping, details, hint, trace context and content type remain
  correct.

## Acceptance

- [x] Consumers with asynchronous audit/identity attribution can use
  `createErrorHook` without reimplementing error normalization.
- [x] There is one public helper, not sync/async variants.
- [x] No application/domain policy is introduced into the core.
- [x] `bun run verify` is green (903 tests, 1922 assertions).

## Non-goals

- Changing the public error-envelope default.
- Moving identity lookup or persistence into Stitchkit.
- Changing tool-call error hooks; this task concerns HTTP lifecycle errors.
- Release, commit, push or downstream migration.

## What was done

- [x] **Core:** `/packages/core/src/server/error-hook.ts` now awaits the observer
  and renderer and passes the matched `MethodDef` to both callbacks.
- [x] **Tests:** `/packages/core/tests/error-hook.test.ts` covers ordering,
  endpoint propagation, pre-route failures and callback rejection; signature
  consistency remains covered by
  `/packages/core/tests/hook-signature-consistency.test.ts`.
- [x] **Documentation:** `/docs/guide/auth-and-errors.md`,
  `/docs/guide/observability.md`, `/docs/api/reference.md`, `CHANGELOG.md` and
  generated LLM guides describe the single asynchronous-capable helper.
- [x] **Validation:** `bun run verify` passed lint, typecheck, 903 tests, build,
  Node smoke and the packed-consumer lane.
- [x] **Not done:** no release, commit, push or downstream migration was
  performed.
