---
title: Restore the react-query-kit-compatible client callable boundary
description: Separate per-call HTTP options from generated endpoint callables so canonical mutationFn composition remains type-safe and unambiguous.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 08:47 +00:00
---

## Зачем

Stitchkit 0.47 added `(args, options?)` to every generated HTTP method. That
second parameter conflicts with TanStack Query's runtime and type-level
`MutationFunctionContext`, so the documented `mutationFn: api.create` pattern no
longer compiles in a consuming application. Consumer lambdas would only hide a
framework regression and are not acceptable.

The public callable must again describe only contract variables. Per-call
transport options need a separate, explicit typed entry point which cannot be
confused with a callback context supplied by another library.

## Результат

- `api.create` is a one-argument callable and remains directly assignable to
  `react-query-kit`/TanStack Query `mutationFn`.
- Per-call cancellation is available through
  `api.create.withOptions(args, { signal })`; an argument-less endpoint uses
  `api.ping.withOptions({ signal })`.
- `withOptions` requires its options argument; it is not a second spelling for
  an ordinary call.
- The ordinary callable ignores any extra runtime callback arguments instead
  of interpreting foreign context as Stitchkit request options.
- There is one clean API: the ambiguous second positional options parameter is
  removed without aliases, wrappers or compatibility branches.
- The correction ships as the next framework release and contains no starter
  update or unrelated work.

## Public API

```ts
const useCreateUser = createMutation({ mutationFn: api.create });

await api.create({ name: 'Max' });
await api.create.withOptions({ name: 'Max' }, { signal });

await api.ping();
await api.ping.withOptions({ signal });
```

## План

- [x] Model generated endpoint methods as a callable-object with a
      contract-only call signature plus a typed, required-options
      `withOptions` method for endpoints with and without arguments.
- [x] Refactor bare Fetch and Ky-backed construction around one internal
      `(requestArgs, options)` executor while keeping the ordinary public
      callable arity and runtime behaviour isolated from foreign callback args;
      remove positional-options parsing rather than adapting it.
- [x] Apply the same type and runtime shape to plain, scoped, batch and
      scope-routed client registries.
- [x] Move every cancellation test and guide example from positional options
      to `withOptions`; assert that positional options no longer compile.
- [x] Add a compile-time regression fixture using the real installed
      `react-query-kit` boundaries for `createMutation({ mutationFn: api.create })`,
      a void mutation and `createQuery({ fetcher: api.search })`.
- [x] Cover argument-less mutation callables and a runtime callback invocation
      that supplies a foreign second argument containing an aborted `signal` or
      throwing getter; the foreign object must remain completely unread.
- [x] Add an ADR and index row for the callable/request-options separation.
- [x] Update README, client guide, API reference, upgrading guide and changelog
      with the hard-cut migration; regenerate LLM docs through the build only.
- [x] Bump the framework to `0.48.0` according to the repository's pre-1.0
      breaking-change policy, run the full release gates and publish exactly
      this correction.

## Acceptance

- [x] `createMutation({ mutationFn: api.create })` typechecks without a
      consumer lambda or cast.
- [x] `createQuery({ fetcher: api.search })` and a void mutation typecheck
      against the real installed `react-query-kit` declarations.
- [x] `api.create({ value }, { signal })` is rejected by TypeScript.
- [x] `api.create.withOptions({ value }, { signal })` cancels both bare Fetch
      and Ky-backed requests with `REQUEST_ABORTED`.
- [x] Ordinary generated methods cannot consume TanStack Query's second
      callback argument as request options at runtime.
- [x] Cancellation parity covers query, JSON, multipart, raw response,
      argument-less and scoped calls in both bare Fetch and Ky clients.
- [x] Scoped and registry-generated methods preserve exact contract arguments,
      output types and the same `withOptions` surface.
- [x] Documentation no longer recommends the removed positional-options form.
- [x] Changelog provides exact before → after migration and identifies the
      `mutationFn` compatibility repair.
- [x] Full `bun run verify` is green before release.
- [x] The published framework version, GitHub Release, tag and verified commit
      all resolve to one SHA.

## Не входит

- A Stitchkit-owned hook engine or consumer-specific React wrappers.
- Automatic cancellation semantics invented for TanStack mutations, whose
  callback context does not provide an AbortSignal.
- Any `create-stitchkit` version, template or lockfile change.

## Конвейер 2/2

- [x] Validator 1: public type shape, TypeScript variance and react-query-kit compatibility.
- [x] Validator 2: runtime boundary, client variants, migration and release scope.
- [x] Implementation validator 1: type/tests/docs equivalence against this mandate — PASS.
- [x] Implementation validator 2: runtime correctness, regressions and single-task release purity — PASS.

## Правки валидатора 1

- Callable types are objects with exactly one ordinary call signature and a
  required-options `withOptions` method; they are not intersections with the
  removed positional form.
- The real `react-query-kit@3.3.4` declarations must compile for mutation,
  void-mutation and query callbacks across plain, batch, scoped and routed
  registries.
- Runtime construction must remove positional parsing and ensure the ordinary
  callable never reads foreign callback context, even if it contains `signal`.

## Правки валидатора 2

- The cancellation matrix retains bare/Ky parity across JSON, query,
  multipart, raw, no-argument and scoped calls.
- A new ADR records why transport options live on a method property rather than
  a callback-compatible positional parameter.
- The release is `stitchkit@0.48.0`; no starter files or package are changed,
  and the tag is created only after exact-SHA CI succeeds.

## Что сделано

- [x] **Public types:** `packages/core/src/contract/define.ts` exposes generated
      endpoint methods as callback-safe callable objects with required
      `.withOptions` methods for explicit request cancellation.
- [x] **Browser runtime:** `packages/core/src/browser/client.ts` uses one internal
      request executor; ordinary methods deliberately ignore every extra
      JavaScript argument, while only `.withOptions` reads transport options.
- [x] **Type regression:**
      `packages/core/tests/client-react-query-kit.type-test.ts` compiles the real
      `react-query-kit@3.3.4` mutation, void-mutation and query boundaries across
      plain, batch, scoped and composed clients, including raw and multipart
      result inference and negative positional-call assertions.
- [x] **Runtime regression:**
      `packages/core/tests/client-cancellation.test.ts` cases `caller abort
      cancels GET, JSON, multipart and raw-response calls`, `scoped methods
      preserve cancellation without sending prefix keys`, `ordinary callables
      ignore foreign callback context completely` and `an already-aborted signal
      never sends the request` pass for bare Fetch and Ky clients.
- [x] **Architecture and migration:**
      `docs/decisions/0073-client-request-options-are-not-callback-context.md`,
      `docs/guide/client.md`, `docs/guide/upgrading.md`, `docs/api/reference.md`,
      both READMEs and `CHANGELOG.md` document the single hard-cut API.
- [x] **Validation:** both plan validators and both implementation validators
      returned PASS; final `bun run verify` passed lint, typecheck, tests, build,
      Node smoke, consumer lane and packed starter lanes (33/33 and 42/42 E2E).
- [x] **Release scope:** only `stitchkit` is bumped to `0.48.0`;
      `create-stitchkit`, its template and its package version are unchanged.
