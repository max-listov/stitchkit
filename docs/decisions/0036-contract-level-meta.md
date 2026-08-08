---
title: "ADR 0036 — `meta` cascades from the contract; `expose` deliberately does not"
type: decision
status: accepted
created: 2026-08-05
updated: 2026-08-05
---

# ADR 0036 — Cascade `meta`, not `expose`

- **Status:** Accepted — extends [ADR 0021](0021-endpoint-meta-passthrough.md);
  records a rejection that amends nothing in [ADR 0016](0016-cli-transport.md).
- **Date:** 2026-08-05

## Context

A consuming project repeated `expose: ['HTTP']` on 28 endpoints across 7
contracts, and `meta` on 73 endpoints across 8 — because `implement()` cascades
`scope` from the contract but takes `expose` and `meta` from the endpoint alone.
The ask was to cascade both.

The `expose` half was framed as safety: *a missing `expose` means the endpoint is
a tool on MCP **and** AGENT, so forgetting one line silently hands an endpoint to
a model.* That framing is right about the default and wrong about the remedy.

## Decision

### `meta` cascades, shallow-merged

`ContractMeta` gains `meta?`, and an endpoint's own `meta` merges **over** it, key
by key. One level, no deep merge — a deep merge invites nested-unset questions
with no clean answer. Neither side declaring anything leaves `meta` `undefined`,
not `{}`, because readers test `method.meta?.x` and an empty object reads as
"declared".

**An explicit `key: undefined` on the endpoint is the opt-out.** The key survives
the spread with value `undefined`, so it shadows the contract's value and every
`meta?.key` reader sees nothing — "the contract turns this on for everyone, this
endpoint turns it off". This is deliberate, not an artifact: a consuming project's
public form-submission endpoint sits in an otherwise admin-gated contract and opts
out of the inherited RBAC page exactly this way. (Their previous `??`-based
cascade *swallowed* the opt-out — `undefined ?? PAGE` is `PAGE` — which silently
put an admin gate on a public endpoint; the live probe returned 401 on the public
form. The spread semantics fix that class.) Note the asymmetry this creates for
`in`-style readers: the key is *present* with value `undefined` — readers must
test the value (`meta?.key`), not membership.

Shallow merge rather than override because `meta` is not decoration: the OpenAPI
generator documents `meta: { public: true }` as the recommended declarative
allowlist for the published spec. Under override, a contract declaring
`{ public: true }` plus an endpoint adding `{ rateTier: 2 }` would silently drop
`public` and the endpoint would vanish from the spec with no diff explaining why.

Applied at **every** `MethodDef` producer — `implement`, `implementRemote` — and
`createContractFactory` now forwards the meta object instead of rebuilding it,
which had silently dropped any field beyond `prefix` and `scope`.

### `expose` does **not** cascade

1. **It would not close the hole.** Forgetting `expose` at *both* levels leaves the
   endpoint exactly as exposed as before. With ~4 endpoints per contract the
   cascade divides the chance of the mistake by 4 and multiplies its blast radius
   by 4 — expected exposure roughly flat.
2. **It would open a new silent vector.** Today an endpoint's exposure is written
   on the endpoint, so moving it between contracts is exposure-neutral. With a
   cascade, moving it into a contract that does not declare `expose` turns it into
   an AI tool **with no diff on the endpoint itself** — the "forgot a line while
   refactoring" scenario, made harder to see in review.
3. **The real remedy already ships and needs no framework change.**
   `listToolNames({ services, runtimeTools })` resolves every tool through the
   same mixed-surface resolver the mounts use; pinned in a snapshot it fails the
   build the moment a forgotten `expose` adds a tool, naming its origin, service,
   method and transports. That catches the both-levels case a cascade cannot.
4. **It would need five more edit sites to not regress.** `browser/client.ts` and
   `tools/remote.ts` read `endpoint.expose` directly; `ExposesHttp` types the
   client off it; `defineContract`'s `toolName` validator reads `ep.expose`, so it
   would stop throwing where it should *and* start throwing on a legal contract;
   and the scoped factory would have dropped the field. A tools-only contract would
   have shipped a typed HTTP client for routes the router refuses to serve.

## Alternatives considered

- **Flip the default to `['HTTP']`** (tools opt-in). Rejected — not because it is
  breaking (this repo's policy explicitly allows that pre-1.0), but because it is
  breaking **silently**: nothing errors, every consumer's tools simply vanish from
  their host. It would also supersede ADR 0016's reasoned default-on baseline.
- **Cascade `expose` anyway, with all five sites fixed.** Rejected on 1 and 2 — the
  ergonomics are real but they are bought with a new silent-change vector, for a
  safety benefit that is roughly nil.
- **A required-`expose` strict factory** (as `createContractFactory` does for
  `scope`). Deferred here; later consumer evidence produced the type-visible,
  materialized factory policy in [ADR 0062](0062-explicit-tool-exposure-is-a-factory-policy.md).
  It does not introduce the contract-level inheritance rejected by this ADR.

## Consequences

- **Additive.** `expose` behaviour is byte-identical to 0.25.0; a contract that
  declares no `meta` is unaffected.
- **A contract-level `meta` now reaches endpoints through the factory too** — code
  that relied on the factory dropping it (there is no reason to) would change.
- **The fail-open `expose` default stays**, documented in the guide next to the
  snapshot recipe that catches it.
