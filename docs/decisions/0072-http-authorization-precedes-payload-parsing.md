---
title: "ADR 0072 — HTTP authorization precedes payload parsing"
description: Separate pre-body authorization from post-validation application hooks so rejected requests consume no payload resources.
type: decision
status: accepted
created: 2026-08-14
updated: 2026-08-14
---

# ADR 0072 — HTTP authorization precedes payload parsing

- **Status:** Accepted — supersedes [ADR 0004](0004-lifecycle-hooks.md) while
  preserving its flat-hook design.
- **Date:** 2026-08-14

## Context

HTTP authorization used to share `beforeHandle` with application
preconditions. That phase runs after query, JSON or multipart parsing so hooks
can depend on validated input. It also meant a request that would ultimately be
rejected for identity or scope could force the server to read and buffer its
entire permitted payload first.

Moving all of `beforeHandle` earlier would reverse the problem: existing hooks
would lose their validated `input` and multipart values. Authorization and
post-validation preconditions therefore have different resource and data
boundaries even when both happen before the handler.

## Decision

The HTTP lifecycle has a dedicated `authorize(context, endpoint)` phase after
route matching and path-parameter validation, but before the first query/body
parse. Its `AuthorizationContext` contains request, URL-derived params,
operation/trace/client metadata and deliberately exposes no payload-derived
state.

Global authorization runs before route-group authorization. A rejection skips
the remaining authorization, parsing, `beforeHandle` and handler phases while
still travelling through canonical error normalization, CORS, logging and the
single request-completion event.

`beforeHandle` keeps its post-validation meaning. `createAuthHook` is wired to
HTTP `authorize`; MCP, Agent and CLI continue to wire the same policy to tool
`beforeHandle` because those transports have already accepted and validated an
input before the shared execution runner begins.

## Alternatives rejected

- Keep auth in `beforeHandle`: rejected uploads can still consume the full
  declared request budget before a `401` or `403`.
- Move `beforeHandle` wholesale before parsing: breaks valid input-dependent
  preconditions and weakens its typed contract.
- Run the same hook in both phases: duplicates authentication, side effects and
  audit work while making order-dependent authorization bugs likely.
- Parse only selected body fields before auth: requires trusting attacker-owned
  payload to decide whether the attacker may send that payload.

## Consequences

- HTTP auth hooks cannot depend on request payload; TypeScript reflects that
  boundary.
- Path parameters remain available for scoped resource routing, and invalid
  path parameters fail before authentication work.
- Consumers migrate one HTTP hook key with no compatibility alias.
- Tool lifecycle remains transport-appropriate rather than pretending it can
  avoid input processing that already happened outside the HTTP dispatcher.
