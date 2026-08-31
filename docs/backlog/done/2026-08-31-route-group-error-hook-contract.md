---
title: RouteGroup accepts onError but the error dispatcher ignores it
description: Align the typed group-hook surface with actual error dispatch and document precedence.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 03:30 +00:00
---

## Evidence

Version 0.70.2. `packages/core/src/server/types.ts` declares
`RouteGroup.hooks?: LifecycleHooks`, including `onError`. In
`packages/core/src/server/create.ts:329`, `respondError` invokes only global
`hooks.onError`; the matched group's hook is never invoked. The same function
does invoke group authorize/beforeHandle/afterHandle hooks.

Reproducer: mount a group with an authorize hook throwing unauthorized() and
an onError returning 401 with `Cache-Control: no-store`. GET the grouped endpoint.
The response is 401 but does not contain the configured cache header. A global
error hook receives the same failure. This affects handler/validation errors too.

## Implementation decision

For a matched contract route, error dispatch tries group `onError`, then global `onError`, then the
existing framework envelope. The first `Response` wins. An absent hook, `undefined` result or
throw continues to the next level with the original error and the same context/endpoint. Hook
failures are reported to the internal diagnostic sink, never substituted into the client response.
This applies to matched params, authorization, payload validation, before/after hooks and handler
failures (including raw-response contract handlers). It does not assign a group to global
`onRequest`, raw routes, unmatched 404/405 or confirmed transport cancellation. Completed streaming
headers retain their existing stream-error path. No public shape or migration is needed.

Implementation and source/packed tests close this task; final publication acceptance belongs to the
core patch release train, which must also verify the registry artifact before release completion.

## Acceptance

- [x] Decide the supported group error-hook semantics and global/group precedence — documented
      above and in `docs/guide/server.md#lifecycle-hooks`.
- [x] Implement the promised hook without changing the declared type — the matched dispatch catch
      supplies its own `groupHooks` to the single HTTP error path.
- [x] Cover authorize, validation, handler errors, group-hook failure and global fallback — exact
      regression cases and packed fixture are listed below.
- [x] Prepare the exact `0.70.3` core patch and packed-consumer proof; transfer final publication
      acceptance to `release-train.json`'s core target. This implementation closure does not claim
      publication: release completion still requires the exact-SHA CI and registry checks below.

No downstream source or deployment is part of this task.

## Что сделано

- `packages/core/src/server/create.ts` passes only the matched contract group's hooks into error
  dispatch. `packages/core/src/server/error-dispatch.ts` handles ordered group/global fallback,
  preserves the original error and contains failures of both the hook and its diagnostic sink.
- `packages/core/tests/route-group-error.test.ts`:
  `group authorize failure uses group onError before the global hook` reproduced the missing
  `Cache-Control` header before the fix, then passed. The parameterized
  `<phase> failure retains matched context and endpoint` cases cover path/payload validation,
  global authorization, global/group before/after hooks and the handler. Separate cases
  `raw routes, 404, 405 and pre-route failures cannot select a group by prefix` and
  `confirmed cancellation bypasses both group and global error hooks` prove the exclusion boundary.
- `packages/core/tests/route-group-error-fallback.test.ts`:
  `<mode> group hook falls through to global with the original error` covers absent/undefined/
  synchronous throw/async rejection; `<mode> global hook falls back to the original standard
  envelope` also covers a broken logger. `concurrent groups and an ungrouped route do not share
  error policy` proves request-local ownership.
- `packages/core/tests/route-group-error-response.test.ts`:
  `group error response preserves CORS, trace and exactly one error completion` proves that the
  shared response path records the original code once; `rawResponse contract handler errors still
  belong to the matched group` covers HTTP-only contract handlers.
- `packages/core/scripts/consumer-lane/fixtures/node/src/route-group-error.mjs` is wired into the
  existing packed node fixture on **both Bun and Node**. It starts each framework HTTP adapter,
  sends real requests and checks authorization/validation/handler responses, cache headers,
  CORS/traces, original-error identity, fallback and private hook diagnostics.
- Type docs, server guide, API reference and `CHANGELOG.md` document the same precedence. No
  alternate mounting path, dependency, compatibility alias or consumer migration was introduced.

## Verification and publication boundary

Focused regression: 23 cases, 138 assertions; related HTTP error/logging suites: 73 cases,
263 assertions. Core typecheck and build passed. The locally packed `stitchkit-0.70.3.tgz` passed
the real HTTP fixture on Bun and Node; this archive is an unpublished candidate, not proof of npm
publication.

The core `0.70.3` release train must run `bun scripts/verify.ts --release`, receive successful
push CI for the full commit SHA, publish that CI artifact through `v0.70.3`, then compare the
registry archive byte-for-byte with `release-packages`. The actual registry archive must pass
`route-group-error.mjs` on Bun and Node. Report version, tag SHA and registry integrity only after
that acceptance. Other packages and consumers are outside this release target.
