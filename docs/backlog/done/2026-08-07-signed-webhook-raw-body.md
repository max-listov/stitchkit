---
title: Preserve raw JSON bodies for signed HTTP webhooks
description: Let an HTTP-only contract endpoint retain the exact decoded request text for HMAC verification without giving up Zod input validation.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 08:09 +00:00
related:
  - docs/decisions/0038-raw-response-endpoints.md
---

# Preserve raw JSON bodies for signed HTTP webhooks

## Confirmed problem

The HTTP route reads `Request.text()` before `beforeHandle` and the handler,
then retains only parsed/validated input. A signed webhook cannot verify the
provider's HMAC over the original JSON text while also declaring `input`.
`rawRoutes` preserve the request but deliberately give up contract validation.

## Plan

- [x] Added opt-in `rawBody: true` to HTTP-only, body-bearing JSON endpoints.
- [x] Typed `ctx.rawBody` as a guaranteed `string` only for opted-in handlers.
- [x] Retained the exact decoded text before JSON/Zod validation, including the
      `onError` path.
- [x] Rejected incoherent declarations (`GET`, multipart, missing input, tool
      exposure) at contract definition time.
- [x] Added optional per-route/server `maxJsonBodyBytes`, enforced while
      streaming before the body is fully buffered.
- [x] Kept multipart, raw routes, tools and endpoints without the flag unchanged.
- [x] Covered whitespace-sensitive HMAC, Unicode, invalid JSON, Zod failure,
      byte limits, Fetch portability and public consumer typing.
- [x] Updated ADR, guide, API reference and changelog.

## Acceptance

- [x] A contract handler validates `input` and verifies an HMAC from
      `ctx.rawBody` without rereading or cloning the request.
- [x] `rawBody` is not guaranteed on normal handler types and has zero retention
      cost unless enabled.
- [x] JSON limits abort the stream once the configured byte ceiling is crossed.
- [x] `bun run verify` passes: lint, typecheck, 821 tests, build, Node smoke and
      all consumer lanes.

## Что сделано

- [x] **Contract/types:** `/packages/core/src/contract/define.ts` and
      `/packages/core/src/server/types.ts` expose the constrained `rawBody` and
      `maxJsonBodyBytes` surface with handler-level type guarantees.
- [x] **HTTP runtime:** `/packages/core/src/server/context.ts` retains the decoded
      JSON text before parsing; `/packages/core/src/server/request-body.ts`
      provides bounded streaming reads shared by Bun and Node Fetch runtimes.
- [x] **Transport isolation:** `/packages/core/src/server/implement.ts`,
      `/packages/core/src/tools/remote.ts` and `/packages/core/src/tools/mount.ts`
      keep raw-body endpoints HTTP-only.
- [x] **Verification:** `/packages/core/tests/raw-body.test.ts` and the full
      consumer fixture cover runtime behaviour and published declaration types.
- [x] **Documentation:** ADR 0051, contract/server guides, API reference and the
      0.37 changelog describe the feature and its memory/size boundary.
- [x] **Not performed:** commit, release and deployment remain outside this task.
