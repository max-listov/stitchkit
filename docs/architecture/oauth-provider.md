---
title: MCP OAuth provider
description: OAuth discovery, deterministic client resolution and secure CIMD loading.
type: architecture
status: active
created: 2026-08-09
updated: 2026-08-09
---

# MCP OAuth provider

## Client resolution

`mountOAuthProvider` resolves a client in one order: exact pre-registered entry,
HTTPS URL Client ID Metadata Document, explicitly enabled Dynamic Client
Registration. CIMD is enabled with secure defaults; DCR is disabled when its
store is absent. Discovery and routes reflect reality: `/register` and
`registration_endpoint` exist only with DCR.

A CIMD document must have an exact URL-equal `client_id`, explicit
`redirect_uris`, a bounded `client_name`, public-client auth method `none` and a
valid application type. Authorization snapshots the exact resolved client id,
redirect URI, PKCE challenge, resource and user into the code; token exchange
uses that stored binding rather than refetching mutable metadata.

## Network boundary

The production fetcher requires HTTPS, rejects credentials/fragments and blocks
private, loopback, link-local, multicast and reserved targets. DNS results are
validated and the connection is pinned to the accepted IP. Every redirect is
resolved and checked again. Timeout, redirect count and response bytes are
bounded.

The cache is bounded, request-coalesced and HTTP-aware. It accounts for
`Cache-Control` (`no-store`, `no-cache`, `max-age`), `Age` and `Expires`,
revalidates with `ETag` or `Last-Modified`, caps origin freshness and uses a
short negative TTL for unavailable/invalid identity. `onCacheEvent` exposes only
client id, hit/miss/revalidation/negative status and freshness — never metadata
contents. It never silently serves stale client identity.

## OAuth invariants

PKCE S256, exact redirect comparison, RFC 9207 issuer parameters, resource
indicators and JWT issuer/audience binding remain mandatory. Redirects reject
credentials and fragments. Consent receives sanitized client display data, the
exact origin/client id, requested scope and a loopback indicator. It returns the
exact approved scope subset; unsupported requests and consent escalation fail
closed. The framework owns protocol mechanics; applications own user
authentication and persistent stores.
