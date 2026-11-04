---
title: "ADR 0283: Factory defaults materialize endpoint exposure by capability"
description: A scoped factory snapshots default transports, intersects implicit exposure with endpoint capabilities, and preserves explicit overrides in runtime data and inferred types.
type: decision
status: accepted
created: 2026-11-04 18:37 +07:00
updated: 2026-11-04 18:51 +07:00
---

# ADR 0283 — Factory defaults materialize endpoint exposure by capability

Amends the configuration API of [ADR 0062](0062-explicit-tool-exposure-is-a-factory-policy.md).
The rejection of contract-level exposure inheritance in [ADR 0036](0036-contract-level-meta.md)
still stands. Serves **I1**, **I3**, **I8**, **I9**, **I12**, **I14**.

## Context

A curated tool surface can be HTTP-only by default, but an application can also deliberately expose
ordinary operations through HTTP and CLI while keeping MCP and AGENT opt-in. A fixed string policy
cannot express that without repeating transport arrays on every operation.

The authored default is not an explicit endpoint assertion. A file download or stream cannot become
a CLI command merely because ordinary operations do. Filtering an explicitly contradictory endpoint,
however, would silently conceal an authoring error. Losing an empty intersection in the server's
HTTP-only fallback would reopen a route the policy hides.

## Decision

Configure one scoped factory in two inference steps:

```ts
const { defineContract } = createContractFactory<AppScope>().configure({
  toolExposure: { default: ['HTTP', 'CLI'] },
})
```

The constructor takes no arguments. Passing the removed constructor policy fails with a migration
hint, including from untyped callers; malformed configuration never falls back to default-on tools.
Scope and policy have separate generic boundaries because TypeScript does not infer an omitted
defaulted generic after a caller explicitly supplies the scope generic. Widening the policy to every
transport would falsely give a CLI-only endpoint an HTTP client method.

Each configuration snapshots its transport array. Before the real `defineContract` validates the
operation, an omitted or `undefined` exposure becomes the default. An explicit array, including `[]`,
replaces it unchanged. The factory does not mutate authored endpoints, the base factory or siblings.
No-config authoring retains HTTP + MCP + AGENT for ordinary endpoints, with CLI opt-in.

One internal contract-owned capability definition covers raw responses, multipart, raw bodies,
response metadata, response streams and HEAD. Implicit defaults intersect with HTTP for these forms.
An empty intersection remains empty through local and remote method conversion, routing and tools.
An explicit non-HTTP exposure is refused at definition, and a hidden endpoint still validates its
descriptor, description and tool options. `safelistedBody` is transport-neutral.

The mapped endpoint type removes the old optional exposure before adding effective alternatives.
Conditional overrides distribute into endpoint variants; intersecting an optional authored tuple with
the default could instead create `never` or falsely guarantee HTTP. All projections read the same
materialized field, not another policy resolver at each transport mount.

An optional capability retains both possible effective tuples. HTTP client methods and URLs require
HTTP to be guaranteed by a tuple member, not merely possible in a widened transport array. This keeps
annotated policy objects and hoisted optional streaming endpoints honest without adding casts. The
rule reads the endpoint type, not how it was authored: an endpoint typed as the broad `EndpointDef`
or `FactoryScopedEndpoint` has no client method under plain `defineContract` or the no-config
factory either, because its `expose` may hold no HTTP. Helpers keep literal endpoint types with a
const generic.

## Alternatives

- Contract-level inheritance: rejected for the authoring-boundary reasons in ADR 0036.
- A constructor config with a second defaulted generic: rejected because explicit scope loses literal
  policy inference; repeating transport tuples in type arguments is another source of truth.
- A compatibility string or overloaded legacy path: rejected; the migration is mechanical and a
  malformed policy must not silently widen a security-sensitive surface.
- Filtering explicit contradictions: rejected because a declared tool would disappear silently.

## Consequences

Existing string-policy callers move to `configure({ toolExposure: { default: ['HTTP'] } })`.
An application choosing HTTP + CLI removes endpoint arrays that repeat the default. Helpers that
build contracts internally own their own exposure.

Factory tests exercise actual HTTP and CLI calls, allowed and denied handler counts, scope gates,
literal manifests, OpenAPI, local/remote normalization, immutable snapshots and malformed inputs.
Type tests pin scope literals, six capability intersections, optional/conditional overrides and the
absence of hidden or CLI-only HTTP client methods and URLs.
