---
title: Decode trailing wildcard path parameters
description: Return semantic wildcard values after typed clients encode each path segment.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 12:19 +00:00
related: docs/backlog/done/2026-08-07-contract-route-trailing-wildcard.md
---

# Decode trailing wildcard path parameters

## Confirmed defect

The typed clients correctly encode every segment of `params['*']`, but the shared
router joins the encoded pathname segments without decoding them. A caller that
sends `folder one/leaf#two` therefore reaches the handler as
`folder%20one/leaf%23two`, unlike an ordinary named path parameter.

## Plan

- [x] Decoded every captured wildcard segment before joining it with `/`.
- [x] Preserved `/` as the wildcard's segment boundary by decoding only after
      matching and capture rather than decoding an
      encoded slash into the routing structure.
- [x] Covered semantic round trips through both typed-client transports.
- [x] Re-ran focused router/client tests and the full project gate.

## Acceptance

- [x] Both typed clients round-trip `folder one/leaf#two` unchanged to the
      handler.
- [x] Existing simple, empty and multi-segment wildcard behaviour remains green.
- [x] Contract and raw routes retain the same shared matcher semantics.
- [x] `bun run verify` passes with 833 tests.

## Boundary

- No consuming repository, version, publication or release operation is part of
  this fix.

## Что сделано

- [x] **Router:** `packages/core/src/server/router.ts` URL-decodes every captured
      wildcard segment in the shared contract/raw matcher before joining the
      semantic remainder.
- [x] **Typed-client regression:** `packages/core/tests/client.test.ts` proves
      both transports round-trip `folder one/leaf#two` without leaking percent
      encoding into the handler.
- [x] **Raw-route regression:** `packages/core/tests/raw-route-match.test.ts`
      proves the shared matcher exposes decoded wildcard values directly.
- [x] **Public contract:** `docs/guide/server.md` and `CHANGELOG.md` explicitly
      document decoded segment semantics.
- [x] **Gates:** focused tests passed 37/37; `bun run verify` passed lint,
      typecheck, 833 tests, build, Node smoke and packed-package consumer lane.
- [x] **Not performed:** no consuming repository, version, publication or
      release operation was changed.
