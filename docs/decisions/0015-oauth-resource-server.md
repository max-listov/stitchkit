---
title: "ADR 0015 — OAuth 2.1 resource-server toolkit for MCP"
type: decision
status: accepted
created: 2026-05-29
updated: 2026-05-29
---

# ADR 0015 — OAuth 2.1 resource-server toolkit for MCP

- **Status:** Accepted
- **Date:** 2026-05-29

## Context

A remote MCP server is connectable from Claude (Desktop / web custom connector)
only through the MCP authorization spec (2025-06-18): OAuth 2.1 with PKCE, plus
Protected Resource Metadata (RFC 9728), Authorization Server Metadata
(RFC 8414), Dynamic Client Registration (RFC 7591) and Resource Indicators
(RFC 8707). A Bearer-only server returns a bare `401` with no
`WWW-Authenticate`; the client cannot discover where to authenticate, so the
connector never establishes.

`createMcpHandler` already owns the MCP transport and emits that `401`. Without
OAuth support every consuming app must hand-roll the same discovery docs, DCR
endpoint and PKCE token flow — security-critical machinery, duplicated and
prone to drift. This is transport-level authentication, not domain logic, so it
belongs in the framework (the same reasoning as ADR 0007: tools from one
contract).

## Decision

stitchkit ships the OAuth **protocol mechanics** as generic primitives; the
consuming app supplies only **identity and persistence**.

Framework (generic, no domain types):

- `createMcpHandler({ protectedResource })` emits
  `WWW-Authenticate: Bearer resource_metadata="…"` on `401` (RFC 9728 §5.1).
- `oauthProtectedResourceRoute()` serves `/.well-known/oauth-protected-resource`.
- `mountOAuthProvider()` returns the authorization-server routes: AS metadata,
  `/register` (DCR), `/authorize` (PKCE) and `/token` (code + refresh).
- `signJwt()` (mirror of the existing `verifyJwt`) and `verifyPkce()` / S256.

Application (domain):

- Pluggable `clients` / `codes` / `refreshTokens` stores.
- An `authorizeUser(req, authRequest)` callback that authenticates the user and
  captures consent — returns `{ userId }`, or a `Response` to drive the browser
  through the app's own login first.

### Token format

Access tokens are signed **HS256 JWTs** whose `aud` is the canonical resource
(MCP URL). Validation is the existing `verifyJwt({ audience })` — no token
store, audience binding for free (RFC 8707). Refresh tokens are opaque, stored,
and rotated single-use (OAuth 2.1 §4.3.1 for public clients).

## Consequences

- Any stitchkit MCP server becomes a native Claude connector by mounting four
  routes and one config field — no `mcp-remote` bridge, no hand-rolled OAuth.
- The framework stays generic (ADR 0002): it never learns what a "user" is; the
  app owns login, consent and storage.
- No new runtime dependency — everything is built on `crypto.subtle`.
- The AS and RS may co-locate (one server) or split; the toolkit supports both
  via the `authorizationServers` list.
