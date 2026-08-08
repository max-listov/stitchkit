---
title: Typed options-object domain error factory
description: Make defineErrors expressive enough to replace consumer AppError subclasses and duplicated status maps without weakening typed details
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 02:01 +00:00
---

# Typed options-object domain error factory

## Problem

`defineErrors({ CODE: status })` provides typed throwing functions, codes and a
guard, but its positional `(message?, details?, hint?)` shape is too weak for
applications with a substantial domain error vocabulary:

- details are only `Record<string, unknown>` and cannot vary by code;
- there is no Zod source of truth for structured details;
- the helper throws immediately, so callers cannot construct, pass, inspect or
  conditionally rethrow a typed error instance;
- large applications therefore keep their own `ApiErrorCode → status` map and
  `AppError` subclass, often adding fallback statuses and compatibility aliases.

The framework should remove that boilerplate without owning any domain codes or
wire-envelope policy.

## Proposed clean model

Use one object-shaped definition and make each generated function construct a
typed branded `AppError`; the caller writes the ordinary `throw`:

```ts
const appErrors = defineErrors({
  USER_NOT_FOUND: { status: 404 },
  RATE_WINDOW: {
    status: 429,
    details: z.object({ retryAfterSeconds: z.number().int().positive() }),
  },
})

throw appErrors.errors.USER_NOT_FOUND()
throw appErrors.errors.RATE_WINDOW({
  message: 'Try later',
  details: { retryAfterSeconds: 30 },
  hint: 'Wait for the current window to expire',
})
```

This is a breaking redesign of `defineErrors`, not a second helper or a
compatibility overload. Pre-1.0 migration belongs in one breaking minor.

## Plan

- [x] Make `AppError` generically preserve a literal code and typed structured
  details while keeping default type parameters for framework/internal use.
- [x] Define one Zod-first error-definition shape: required HTTP status and an
  optional object schema for details.
- [x] Generate one constructor function per code accepting a named options
  object (`message`, typed `details`, `hint`) and returning a branded error
  instance.
- [x] Make details required/optional/forbidden according to the declared schema;
  runtime-parse supplied details at the boundary.
- [x] Preserve `codes` and `isCode` with exact code literals derived from the
  same definition object.
- [x] Expose the definition/status registry read-only so error rendering and
  OpenAPI/diagnostics can consume the same source without a copied map.
- [x] Ensure HTTP, MCP, Agent and in-process invocation preserve exact
  code/status/message/details/hint through normalization.
- [x] Remove the positional thrower API rather than retaining overloads,
  deprecated aliases or a `defineErrorsV2` parallel path.
- [x] Update auth/errors guide, API reference, starter examples, generated LLM
  docs and `[Unreleased]` breaking section with before/after migration.

## Tests

- [x] Code literals and per-code details infer exactly at compile time.
- [x] A code without a details schema rejects details at compile time.
- [x] Invalid runtime details fail loudly at error construction.
- [x] Constructed errors pass `AppError.is()` across bundled/cross-realm copies.
- [x] Normalization preserves custom status and typed details on HTTP and tool
  transports.
- [x] `codes`, `isCode` and the status registry cannot drift.
- [x] No fallback status is required for a declared code.

## Acceptance

- [x] A consumer can declare its full domain error vocabulary once without an
  `AppError` subclass or a duplicate status map.
- [x] The API is object-shaped, Zod-first and free of positional ambiguity.
- [x] There is one clean public factory with no compatibility layer.
- [x] The core remains domain-free and envelope-agnostic.
- [x] `bun run verify` is green (911 tests, 1957 assertions).

## Non-goals

- Standardizing application error codes or localized messages.
- Making arbitrary non-object values valid error details.
- Replacing `createErrorHook` or choosing an application wire envelope.
- Release, commit, push or downstream migration.

## Settled transport semantics

The constructed and normalized `AppError` retains the exact
code/status/message/details/hint. HTTP renders all five fields. MCP and Agent
keep their existing model-facing projection (code/details/hint; no HTTP status),
while `invokeOrThrow` recovers the retained exact `AppError`. `defineErrors`
does not change transport envelopes or leak HTTP policy into model results.

## What was done

- [x] **Error model:** `/packages/core/src/contract/errors.ts` makes `AppError`
  generic over literal code and details; branding and existing helpers remain
  unchanged.
- [x] **Factory:** `/packages/core/src/contract/errors-factory.ts` implements the
  breaking object-definition/options-object API, Zod detail parsing, frozen
  definitions/codes/factories and exact guards without compatibility overloads.
- [x] **Typing boundary:** `/packages/core/src/internal/typed.ts` contains the
  documented dynamic mapped-object bridge; public conditional types remain
  assertion-free at consumer call sites.
- [x] **Tests:** `/packages/core/tests/define-errors.test.ts` covers positive and
  negative inference, invalid runtime definitions/details, immutability, brand,
  HTTP/MCP/Agent projections and exact in-process rethrow.
- [x] **Packed consumer:** the full consumer-lane fixture constructs a typed
  schema-backed domain error from the published package.
- [x] **Documentation:** ADR 0058, decisions index, auth/errors and upgrading
  guides, API reference, changelog and generated LLM docs describe the clean
  migration and transport semantics.
- [x] **Validation:** `bun run verify` passed lint, typecheck, 911 tests, build,
  public declaration checks, Node smoke and all packed-consumer lanes.
- [x] **Not done:** no release, commit, push or downstream migration was
  performed.
