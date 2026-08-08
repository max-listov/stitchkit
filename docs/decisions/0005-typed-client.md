---
title: "ADR 0005 — The typed client is inferred from the contract"
type: decision
status: accepted
created: 2025-05-01
updated: 2026-05-20
---

# ADR 0005 — The typed client is inferred from the contract

- **Status:** Accepted
- **Date:** 2025-05 (core), 2026-05 (pilot fixes)

## Context

One source project hand-wrote its frontend client — a fetch wrapper plus
per-endpoint hooks in separate files. The contract was not used for client-side
inference, so the client could silently drift from the server.

During design, an alternative emerged: a `TypedClient<C>` type that derives
the entire client API from the contract, with one typed function per endpoint.

## Decision

The typed client lives in the core. `createClient` / `createClients` build a
fully typed client from a contract with no hand-written per-endpoint code;
`createHttpClient` is the Ky-based transport adapter underneath (cookie auth,
SSR cookie forwarding, error parsing, transport retry).

Putting this through a real frontend (the pilot migration) exposed three subtle
defects, all now fixed:

- **Arguments are typed with `z.input`, not `z.output`.** The client *sends*
  pre-parse input; the server parses it to output. A field with `.default()`,
  `.coerce()` or `.transform()` differs between the two. Using the output type
  made server-defaulted fields *required* on the caller. `EndpointArgs` uses
  `z.input`; the handler's `ctx.input` keeps the output type.
- **The empty case is `{}`, never `Record<string, never>`.** The latter carries
  an index signature that poisons every intersected field to `never`, collapsing
  the whole argument type. `{} & X = X`. (`{}` was later written as `unknown`,
  which has the same intersection identity and is lint-clean.)
- **`defineContract<const T>`** preserves string literals (`multipart`,
  `method`, `path`). Without `const`, `multipart: 'file'` widened to `string`
  and the multipart argument type degraded to an index signature.

A per-endpoint `timeout` was also added: a slow synchronous endpoint (AI
generation) declares its own client timeout once, in the contract.

## Consequences

- Any contract yields a fully typed client; the transports cannot drift from it.
- Server-defaulted input fields are optional for the caller, as they should be.
- The client never needs an `as` cast to satisfy a contract method signature.
