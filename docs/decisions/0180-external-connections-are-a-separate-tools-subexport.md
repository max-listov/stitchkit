---
title: "ADR 0180: External MCP and OpenAPI connections are a separate tools subexport"
description: "Consuming outside MCP servers and OpenAPI specs becomes a typed tool surface in stitchkit/tools/connections, with non-durable principal-scoped tokens, a narrow transport fallback and typed reauthorization."
type: decision
status: accepted
created: 2026-09-12
updated: 2026-09-12T16:27+07:00
---

# ADR 0180 — External connections are a separate tools subexport

## Decision

`stitchkit/tools/connections` consumes MCP and OpenAPI without adding peers to
the stable tools entrypoint. Definitions mount through the existing `mountAgent`
lifecycle, hooks and approval machinery exactly once. Schema budget remains
visible through the catalog.

Credentials are resolved for every invocation from the handler context; there
is no shared token cache. Discovery is a separate handshake with no runtime
principal context. MCP discovery and each call own separate clients, all torn
down on completion or refusal. A `401` raises
`ConnectionAuthorizationRequiredError`; through `mountAgent`, the typed cause
is retained on `AgentToolError.cause` while model-facing output stays generic.
The host handles reauthorization and the next call resolves credentials again.
A `403` remains a request refusal.

Streamable HTTP falls back to legacy SSE only on 400, 404 or 405. SSE endpoint
readiness and response waiting have deadlines and propagate cancellation.
Response bodies and frames are bounded; teardown cancels readers and waiters.
Redirects are refused on every request, including spec loading. A remote spec
cannot authorize its own foreign server: extra hosts require `allowHosts` or
an explicit application `baseUrl`. Configured hosts are trusted endpoints;
this is a host fence, not a DNS-rebinding or private-network classifier.

## OpenAPI subset

JSON documents, inline or URL; GET/HEAD/POST/PUT/PATCH/DELETE; scalar path,
query, header and cookie parameters; JSON request bodies. Local references
resolve with bounded expansion. External/recursive references, server variables,
structured parameter serialization, non-JSON bodies and combined security
schemes are refused at mount. Security supports one bearer/basic/API-key scheme
per alternative; OAuth/OIDC use a host-provided bearer, not an OAuth client.
Unknown security requirements are refused. Response schemas are not compiled:
the bounded response is decoded as JSON or text and has an unknown output type.

## Boundaries

This is a bounded client implementation, not a claim of complete MCP/OpenAPI
standard coverage. URL configuration and provider grants remain host-owned.
