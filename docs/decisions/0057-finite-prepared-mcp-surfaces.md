---
title: "ADR 0057 — Finite prepared MCP surfaces"
description: A bounded identity-selected registry compiles contract and runtime tool descriptors once while request state stays fresh.
type: decision
status: accepted
created: 2026-08-08
updated: 2026-08-08
---

# ADR 0057 — Finite prepared MCP surfaces

- **Status:** Accepted — extends the neutral runtime operation of
  [ADR 0055](0055-runtime-tools-share-one-neutral-operation.md), supersedes the
  protected registrar shape of
  [ADR 0048](0048-framework-owned-native-mcp-registration.md), and preserves
  per-call isolation from
  [ADR 0045](0045-a-tool-call-runs-in-its-own-context.md)
- **Date:** 2026-08-08

## Context

A static MCP contract surface is prepared once, but an identity-dependent
`services(auth)` factory must be rebuilt for every fresh stateless server. That
is correct for arbitrary per-identity definitions. It repeats expensive schema
collection, presentation compilation, JSON Schema validation and collision
checks when the real domain has only a few immutable surfaces such as two roles.

Protected runtime operations also entered through a registrar callback. The
callback mixed immutable definitions with fresh server construction, so their
schemas could not be prepared independently of request state.

## Decision

Managed MCP operations are data, not registration callbacks:

- direct configuration declares `services` and `runtimeTools`, each either
  static or an identity factory;
- bounded configuration declares a finite `surfaces` record whose entries own
  both arrays, plus a typed `selectSurface(auth)` key selector;
- `createMcpHandler` eagerly prepares every finite entry exactly once and keeps
  only frozen contract/runtime descriptors;
- every request or stateful session still creates a fresh SDK server and binds
  current auth, context, lifecycle and hooks to those descriptors;
- an unknown selector key fails before an SDK server is connected;
- deliberately unprotected SDK registration is isolated under `rawTools`.

The direct identity factories remain available for genuinely unbounded or
request-derived definitions and are deliberately not cached. No global cache or
per-user map exists.

## Alternatives rejected

- **Cache `services(auth)` by identity.** Tokens and user ids create an
  unbounded retention surface and make invalidation application-specific.
- **Reuse an SDK server or transport.** Both own session/request state and would
  break stateless isolation and concurrent calls.
- **Keep a protected registrar beside `runtimeTools`.** Two managed
  registration paths can drift in validation and preparation behavior.
- **Infer finite keys from auth values.** Roles and plans are application data;
  the framework only checks declared string keys.

## Consequences

- Large bounded surfaces pay schema preparation at handler construction rather
  than on every stateless request.
- Contracts and runtime tools share one eager collision and schema-validation
  boundary per surface.
- Auth and request-scoped values never enter the prepared registry.
- Migrating protected tools is mechanical: replace a registrar callback with a
  `runtimeTools` array; raw SDK users rename the explicit escape hatch to
  `rawTools`.
