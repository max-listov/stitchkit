---
title: "ADR 0053 — HEAD is an explicit contract operation"
description: Model HEAD as a bodyless HTTP-only raw-response operation instead of an implicit GET alias or raw-route fallback.
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0053 — HEAD is an explicit contract operation

- **Status:** Accepted — extends the raw-response boundary in
  [ADR 0038](0038-raw-response-endpoints.md) and file semantics in
  [ADR 0023](0023-range-file-serving.md)
- **Date:** 2026-08-07

## Context

`serveFile` already implements HEAD, ranges and conditional requests, but the
contract method union could not declare HEAD. File and link-preview operations
therefore needed a raw route, losing contract identity, params, lifecycle/RBAC,
typed-client and OpenAPI coverage.

Treating GET as an automatic HEAD alias would hide a second operation from the
contract and make its authorization, observability and `Allow` semantics
implicit. A typed JSON output is also the wrong result model: HEAD has no
response body, while its useful result is status plus headers.

## Decision

Add explicit `method: 'HEAD'` endpoints. They are HTTP-only raw-response
operations and must declare `rawResponse: true`. They may declare path params
and response `contentType`, but cannot declare input/output schemas, multipart,
raw-body retention or tool metadata/exposure.

GET and HEAD on the same path remain distinct router entries. A declared GET
does not match HEAD, and vice versa. Method mismatch responses list only the
operations actually declared for that path.

The handler receives the original `Request` and returns a `Response`, allowing
`serveFile` and custom handlers to derive conditional/range status and headers.
After the handler returns, Stitchkit constructs a bodyless response preserving
status, status text and headers. This makes the wire invariant hold even if a
custom handler accidentally supplied a body.

The built-in HTTP client exposes `head`; a typed HEAD contract method resolves
to the untouched `Response`. OpenAPI publishes the HEAD operation and a
bodyless success response.

## Alternatives rejected

- **Implicit GET → HEAD fallback.** It invents an undeclared operation and
  obscures lifecycle, authorization and `Allow` behavior.
- **Raw route with `method: 'ALL'`.** It bypasses the contract-owned lifecycle
  and repeats route identity outside the contract.
- **Typed empty output.** It hides the only useful result—status and headers—and
  suggests JSON parsing where no body exists.
- **Permit request input.** Query data remains available through `req.url`; a
  declared input would imply transport and validation semantics that HEAD does
  not need.

## Consequences

- File and metadata probes can be fully contract-owned.
- Custom `HttpClient` adapters add a `head` primitive.
- HEAD remains deliberately unavailable to MCP, agent and CLI transports.
- Raw-response `afterHandle` behavior remains unchanged: it is skipped because
  there is no typed data result to transform.
