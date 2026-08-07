---
title: Contract-driven URL builders
description: Generate browser-native GET URLs from contracts using the exact client URL planner without issuing a request.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 12:47 +00:00
related: docs/backlog/done/2026-08-07-scoped-batch-clients.md
---

# Contract-driven URL builders

## Evidence and current gap

Browser-native consumers such as `<img src>`, `<video src>`, downloads and
navigation need a URL rather than a fetched body. Stitchkit currently knows the
base URL, contract prefix, endpoint path, scoped prefix keys, path params and GET
query schema, but exposes that composition only as part of executing a request.

Consumers therefore repeat contract paths as strings. This creates a second
source of truth and can drift from wildcard encoding, scoped prefixes and query
serialization.

## Chosen public shape

Mirror the single/batch client APIs with synchronous builders:

```ts
const mediaUrls = createUrlBuilder(mediaContract, http, mediaScope);
const src = mediaUrls.file({
  tenantId,
  fileId,
  thumbnail: true,
});

const urls = createUrlBuilders({ media: mediaContract, exports }, http, scope);
```

- `createUrlBuilder` accepts one contract; `createUrlBuilders` accepts a
  `name → contract` registry and preserves each exact builder type.
- Only HTTP-exposed, non-multipart `GET` endpoints appear. A
  POST/PUT/PATCH/DELETE operation or multipart upload is not a
  browser-navigation URL because its request semantics cannot be encoded
  faithfully in a link.
- Raw-response GET endpoints are linkable; byte streams/downloads are a primary
  use case.
- A builder method is synchronous and returns `string`; it performs no fetch and
  does not run output validation.
- Args are derived from endpoint params + GET input + scoped keys. Path/scoped
  keys are excluded from query.
- Named params use `encodeURIComponent`; trailing wildcards encode each segment
  separately; query arrays use repeated keys and nested objects fail first by the
  same rule as the typed client.
- Relative base URLs produce relative URLs; absolute base URLs produce absolute
  URLs.

To avoid repeating `baseUrl`, `createHttpClient` returns an additive
`ConfiguredHttpClient` subtype carrying `readonly baseUrl: string`. Existing
custom `HttpClient` adapters remain valid; a URL builder accepts either that
configured subtype or an explicit `{ baseUrl }` URL config.

## One planner, not a third URL implementation

Extract one pure internal request-URL planner used by:

1. the framework `HttpClient` contract path;
2. the bare-fetch contract path;
3. single and batch URL builders.

It owns path-prefix resolution, named/wildcard substitution, consumed-key
stripping and query collection/serialization. Transport execution, headers,
body/form-data construction, timeouts and response parsing stay outside it.

## Implementation plan

- [x] Extract the current URL/path/query logic into one pure internal planner;
      remove the two client-side composition branches rather than wrapping them.
- [x] Preserve existing fail-first query validation and endpoint-identifying
      error messages.
- [x] Add `ConfiguredHttpClient extends HttpClient` with readonly `baseUrl`, and
      return it from `createHttpClient` without making the property mandatory on
      third-party `HttpClient` implementations.
- [x] Define type-level `GET + HTTP exposed + non-multipart` filtering and
      synchronous URL function types, including scoped keys and zero-argument
      endpoints.
- [x] Implement `createUrlBuilder` and `createUrlBuilders` on the shared planner;
      the batch API must only map the registry.
- [x] Add compile-time probes: exact args, required path/scope keys, omitted
      non-GET and non-HTTP endpoints, wildcard input and exact registry keys.
- [x] Add runtime equality tests comparing builder output with the actual URL
      observed from both typed-client transports.
- [x] Cover reserved characters, spaces, Unicode, wildcard segment boundaries,
      empty wildcard remainder, repeated query arrays, booleans/numbers and
      missing params.
- [x] Cover relative and absolute base URLs, static and dynamic scoped prefixes,
      and raw-response GET endpoints.
- [x] Add exports, API reference, client/raw-response guides, generated
      `llms.txt` surface and unreleased changelog.
- [x] Run the full `bun run verify` gate including Node and packed-consumer
      checks.

## Acceptance

- [x] Every produced URL is generated from the contract and the same pure
      planner used by both request clients.
- [x] Changing a contract prefix/path changes clients and URL builders together;
      no duplicated route template remains inside Stitchkit.
- [x] Builder types include exactly HTTP, non-multipart GET endpoints and
      preserve each endpoint's params, input, wildcard and scoped-key
      requirements.
- [x] Path/scoped fields never leak into query; query encoding matches the
      executing client exactly.
- [x] No network request, retry, auth event, header provider or output parser runs
      while building a URL.
- [x] A framework-created `HttpClient` supplies its base URL without repeating
      configuration; custom adapters can pass an explicit URL config without a
      compatibility shim.
- [x] No mutation/body operation is presented as a link.
- [x] `bun run verify` passes: 841 tests plus build, Node smoke and all packed-consumer lanes.

## Non-goals

- No automatic `<img>`/download/UI helper is added.
- No auth token is embedded into URLs; cookie/browser auth remains the
  consumer's responsibility.
- No POST form, OAuth protocol model or signed-URL generator is introduced.

## Что сделано

- [x] **Contract/browser types:** URL-only endpoint filtering and exact scoped
      method signatures live in `packages/core/src/contract/define.ts`; public
      exports are wired through `packages/core/src/contract/index.ts` and
      `packages/core/src/index.ts`.
- [x] **Shared planner:** path prefixes, params, trailing wildcards, consumed-key
      stripping and flat query serialization are centralized in
      `packages/core/src/browser/client-url.ts` and used by both executing client
      transports plus URL builders.
- [x] **Client API:** `createUrlBuilder`, `createUrlBuilders` and
      `UrlBuilderConfig` live in `packages/core/src/browser/client.ts`;
      `ConfiguredHttpClient.baseUrl` lives in
      `packages/core/src/browser/http.ts`.
- [x] **Tests:** runtime parity, no-I/O behavior, filtering, encoding, scoped
      keys, raw GET links, relative bases and fail-first validation are covered
      by `packages/core/tests/url-builder.test.ts` alongside existing client
      suites.
- [x] **Docs:** `docs/guide/client.md`, `docs/guide/server.md`,
      `docs/api/reference.md`, generated consumer docs and `CHANGELOG.md` describe
      the public surface.
- [x] **Что НЕ делалось:** no UI helpers, signed/auth URLs, mutation links,
      compatibility aliases, commit, release or deployment were introduced.
