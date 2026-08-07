---
title: Typed JSON response metadata
description: Let HTTP-only contract handlers attach dynamic headers while retaining typed output validation and declared success status.
type: task
status: done
created: 2026-08-05
updated: 2026-08-07
completed: 2026-08-07 12:59 +00:00
related: docs/decisions/0038-raw-response-endpoints.md
---

# Typed JSON response metadata

## Defrost evidence

The original task waited for a real consuming migration to identify the missing
surface. That evidence now exists: typed authentication endpoints need to return
schema-validated user data and append one or more `Set-Cookie` headers. Marking
them `rawResponse: true` changes the typed client result to `Response`, forcing
the consumer to call `response.json()` and parse the same output schema again.

This is a framework boundary, not application auth logic: the server serializer
owns the outgoing JSON `Response`, so only the framework can preserve typed data
and attach response headers in one path.

## Constraints from accepted architecture

- ADR 0027 keeps ordinary contract execution transport-neutral.
- ADR 0038 deliberately reserves `rawResponse: true` for cases where the
  `Response` itself is the operation: bytes, range responses, SSE and redirects.
- A normal data handler must not return a `Response` or a library envelope that
  leaks through MCP/agent/CLI output validation.
- Output validation, `afterHandle`, error normalization, CORS, request IDs and
  logging remain framework-owned.
- The contract must remain truthful to OpenAPI; an undeclared runtime status
  switch is not acceptable.

## Chosen model

Add an explicit HTTP-only typed-data endpoint variant:

```ts
complete: {
  method: 'POST',
  path: '/complete',
  desc: 'Complete authentication',
  input: CompleteAuthSchema,
  output: AuthUserSchema,
  responseMeta: { status: 200 },
}
```

The variant gives its handler an outbound metadata collector while the handler
still returns ordinary typed data:

```ts
complete: async ({ input, response }) => {
  const { user, sessionId } = await authenticate(input.token);
  response.headers.append('Set-Cookie', sessionCookie.set(sessionId));
  return user;
},
```

### Contract semantics

- `responseMeta` is a required object discriminant for this endpoint variant and
  makes it HTTP-only. `implement` carries/forces `expose: ['HTTP']`; tool mounts,
  CLI and future transport dispatchers skip it by construction.
- `responseMeta.status` is an optional **declared static success status**. Default
  is the current `200` for data and `204` for no data. Supported values are
  successful 2xx statuses; the OpenAPI response uses the declared code.
- A bodyless status (`204`/`205`) with an `output` schema is rejected at contract
  definition and again at runtime. Dynamic per-call success statuses are out of
  scope until a contract model for multiple responses has real evidence.
- `rawResponse`, tool metadata and non-HTTP exposure are forbidden on this
  variant. `rawResponse` remains the only route for redirects, byte streams,
  range/conditional responses and SSE.

### Handler context

- Only this variant receives required `ctx.req` and `ctx.response` fields.
- `ctx.response.headers` is a Web Fetch `Headers` bag. It supports `set` and
  `append`; repeated `Set-Cookie` values must survive Bun and Node serialization.
- The handler never constructs or returns `Response` and never controls the body.
- Framework-owned headers (`Content-Type`, `Content-Length`, CORS headers and
  `x-request-id`) cannot be overwritten. Attempting to set them fails loudly
  with an endpoint-identifying error rather than being silently discarded.
- Metadata is applied only after handler success, hooks and output validation.
  If any step throws, accumulated success headers are discarded and the normal
  error response path owns the response.

### Lifecycle and client semantics

- `beforeHandle` and both group/global `afterHandle` keep their current order.
  `afterHandle` sees/transforms data only; response metadata remains beside it.
- Output validation runs on the final transformed data exactly once.
- The typed client resolves to the output type, not `Response`; no client API or
  manual output parsing is added.
- A no-output handler remains `Promise<void>` and can use a declared non-body
  success status. Existing ordinary `undefined/null → 204` behaviour is unchanged.

## ADR before code

This adds a new endpoint class and a controlled HTTP-only exception to transport
neutrality. Before implementation, write the next ADR that records the model
above, explicitly extends ADR 0027 and distinguishes it from ADR 0038. Add it to
`docs/decisions/README.md`. The ADR is a plan step, not a second open design
exercise; implementation follows the accepted shape unless validation finds a
contradiction in the real types/runtime.

## Implementation plan

- [x] Write and index the response-metadata ADR, including rejected alternatives:
      returning `Response`, returning a cross-transport envelope, optional no-op
      context on tool calls, dynamic undeclared statuses and cookie-specific API.
- [x] Add the discriminated endpoint definition and runtime assertions for
      output/status/exposure/raw/tool combinations.
- [x] Add public `ResponseMetadata` context types without weakening ordinary
      `HandlerContext` or introducing casts in business logic.
- [x] Create a fresh per-request header collector and attach it only to matching
      HTTP handler contexts; prove parallel requests cannot share headers.
- [x] Merge successful metadata into the JSON/empty response after hooks and
      output validation, while protecting framework-owned headers.
- [x] Preserve repeated `Set-Cookie` values and declared 2xx status through Bun
      `createHandler`/`createServer` and Node `serveNode`.
- [x] Teach `implement`/`implementRemote`, OpenAPI, route diagnostics and every
      exposure reader that this is typed JSON but HTTP-only.
- [x] Keep normal data endpoints rejecting a returned `Response`; keep
      `rawResponse` behaviour byte-identical.
- [x] Add compile-time tests for legal typed-data metadata handlers and forbidden
      raw/tool/output-status combinations.
- [x] Add runtime tests for one and multiple headers, multiple cookies, custom
      declared success status, default 200/204, output validation, transformed
      output, thrown handler/hook, reserved headers and concurrent isolation.
- [x] Add client tests proving the result remains parsed output data and 204
      remains `undefined` on both client transports.
- [x] Update contracts, server, auth/errors and raw-response guides; API reference;
      ADR index; generated agent docs; OpenAPI snapshots; unreleased changelog.
- [x] Extend Node smoke/consumer fixtures where required and run
      `bun run verify`.

## Acceptance

- [x] An HTTP-only contract handler can append `Set-Cookie` or another allowed
      response header and return ordinary schema-validated data.
- [x] The typed client resolves to the exact output type; it never exposes a
      `Response` and performs no second manual schema parse.
- [x] `afterHandle` and output validation retain their existing data semantics;
      metadata is applied only to the successful final response.
- [x] Multiple `Set-Cookie` headers survive on Bun and Node.
- [x] Reserved framework headers cannot be forged or silently overwrite CORS,
      content framing or request identity.
- [x] A declared success status is reflected in runtime and OpenAPI; bodyless
      statuses cannot carry typed output.
- [x] Error responses cannot inherit success cookies/headers.
- [x] Parallel calls have isolated metadata collectors.
- [x] Raw byte/stream/redirect endpoints remain exclusively `rawResponse: true`
      and unchanged.
- [x] Non-HTTP transports cannot advertise or execute the metadata endpoint.
- [x] No cookie/session/auth domain model enters Stitchkit.
- [x] `bun run verify` passes: 854 tests, build, Node smoke and every packed-consumer lane.

## Non-goals

- No redirect-with-typed-body abstraction.
- No dynamic per-call status union without a declared multi-response contract.
- No cookie parser/store/session framework; existing cookie serializers provide
  header values.
- No consumer migration from this repository.

## Что сделано

- [x] **Decision/contract:** ADR 0052 defines the HTTP-only typed-data model;
      `packages/core/src/contract/define.ts` adds the discriminated endpoint,
      static success-status types, runtime assertions and the public
      `ResponseMetadata` collector type.
- [x] **Runtime:** `packages/core/src/server/response-metadata.ts` owns isolated
      header collection, reserved-header enforcement and repeated `Set-Cookie`
      copying; `packages/core/src/server/create.ts` applies it only after hooks
      and output validation succeed.
- [x] **Surfaces:** `implement`, `implementRemote`, tool collection and OpenAPI
      carry the endpoint as typed JSON while forcing HTTP-only exposure and the
      declared response code.
- [x] **Tests:** contract/type boundaries, Bun/Node cookies, statuses, clients,
      raw-body composition, hook/output failures, reserved headers and parallel
      isolation are split across
      `packages/core/tests/response-metadata-contract.test.ts`,
      `packages/core/tests/response-metadata-runtime.test.ts` and their fixture.
- [x] **Distribution:** the real Node smoke and packed minimal consumer exercise
      the new public surface without ambient Bun types; generated declarations
      and consumer docs pass their guards.
- [x] **Docs:** contracts, server, auth/cookies, API reference, changelog and ADR
      index describe one canonical API and distinguish it from `rawResponse`.
- [x] **Что НЕ делалось:** no session/auth domain model, dynamic status envelope,
      compatibility shim, consumer migration, commit, release or deployment was
      added.
