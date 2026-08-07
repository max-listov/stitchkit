---
title: Scoped batch clients and fully typed prefix arguments
description: Extend createClients with the same scoped config and inference as createClient, without a second runtime.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 12:39 +00:00
related: docs/decisions/0025-typed-scoped-client.md
---

# Scoped batch clients and fully typed prefix arguments

## Evidence and current gap

`createClient(contract, transport, config)` already makes keys listed in
`stripPrefixKeys` required on every endpoint method. The batch
`createClients(registry, transport)` accepts no contract config, and
`ContractClientConfig.pathPrefix` still receives `Record<string, unknown>`.

A consuming project therefore maintains its own mapped client types, scoped
factories and registry traversal for several groups of contracts. That duplicates
HTTP exposure filtering, schema-derived input/output types and multipart call
shapes already owned by Stitchkit.

## Chosen public shape

Extend the existing APIs rather than adding another client family:

```ts
const tenantApi = createClients(tenantContracts, http, {
  stripPrefixKeys: ['tenantId'],
  pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
});
```

- `createClients` receives the same third `ContractClientConfig` as
  `createClient`.
- Every registry key retains its exact contract client type.
- The consumed-key generic types both the returned endpoint arguments and the
  `pathPrefix` callback. `tenantId` is `string`, required and needs no cast or
  `String(...)` coercion.
- The callback may only depend on declared consumed keys. A dynamic prefix that
  reads call arguments must list those keys; a callback with no consumed keys may
  ignore its argument or close over external state.
- Inference must be independent of whether `pathPrefix` or `stripPrefixKeys`
  appears first in the object literal.
- Batch construction delegates every entry to `createClient`; it must not copy
  endpoint filtering, multipart handling or request dispatch.
- `createClients` accepts the same transport choices as `createClient`:
  framework `HttpClient` and the bare `ClientConfig` fetch path.

The existing generic names may change internally, but there remains one public
`ContractClientConfig`, one `createClient` runtime and one batch mapper.

## Implementation plan

- [x] Refine `ContractClientConfig` so `pathPrefix` is contextually typed from
      its `stripPrefixKeys` generic instead of `Record<string, unknown>`.
- [x] Preserve the zero-scope case without forcing args onto ordinary clients.
- [x] Extend `createClients` with the config generic and return each registry
      entry as `ScopedHttpClient<endpoints, ScopedKeys>`.
- [x] Widen `createClients`' transport argument to the same
      `ClientConfig | HttpClient` union accepted by `createClient`.
- [x] Keep the runtime as `registry → createClient(contract, transport, config)`;
      do not introduce another endpoint loop or request builder.
- [x] Add compile-time probes for callback inference with both object-property
      orders, required scoped keys, exact output types and forbidden missing or
      wrong-typed scope keys.
- [x] Add batch type probes proving HTTP-hidden endpoints stay absent and
      multipart remains the canonical one-object call with
      `Blob | FileDescriptor`.
- [x] Add runtime coverage for scoped URL prefixing and stripping on GET query,
      JSON body and multipart requests through the framework `HttpClient`.
- [x] Cover the bare `ClientConfig` batch path and raw-response return type.
- [x] Update the client guide, multi-tenant guide, API reference, generated
      `llms.txt` surface and unreleased changelog.
- [x] Run the full `bun run verify` gate.

## Acceptance

- [x] `createClients(registry, http, scopeConfig)` preserves the exact client
      type for every registry key.
- [x] Scope keys are required `string` arguments on every HTTP endpoint method
      and never appear a second time in query, JSON or multipart fields.
- [x] `pathPrefix: ({ tenantId }) => ...` gets a typed `tenantId` without casts,
      and inference is identical in either property order.
- [x] HTTP exposure filtering, endpoint params, wildcard params, input/output,
      raw responses and multipart inference are byte-for-byte/runtime-equivalent
      to calling `createClient` separately for each contract.
- [x] Multipart keeps one canonical object argument; no two-argument overload or
      compatibility shim is added.
- [x] No domain-specific scope names or resource hierarchy enter the framework.
- [x] No duplicate endpoint registry traversal or second request runtime exists.
- [x] `bun run verify` passes.

## Non-goals

- No consumer migration is performed from this repository.
- No two-argument multipart API is added.
- No scope enum, tenant model or fixed URL hierarchy is introduced.

## Что сделано

- [x] **Public typing:** `packages/core/src/browser/client.ts` types dynamic
      prefix callbacks from their consumed keys and exports `PathPrefixArgs`.
- [x] **Batch runtime:** `createClients` accepts both transport modes plus the
      scoped config and delegates every registry entry to `createClient`.
- [x] **Parity coverage:** `packages/core/tests/scoped-client.test.ts` covers
      query, JSON, multipart, raw responses, HTTP filtering, both config orders
      and the bare-fetch path.
- [x] **Docs:** client/multi-tenant guides, API reference, generated agent docs
      and the unreleased changelog describe the unified batch API.
- [x] **Gates:** `bun run verify` passed lint, typecheck, 836 tests, build, Node
      smoke and packed-package consumer lane.
- [x] **Not performed:** no consumer migration or alternate multipart API was
      added.
