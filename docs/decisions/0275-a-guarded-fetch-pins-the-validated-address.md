---
title: "ADR 0275: A guarded fetch pins the address it validated"
description: The SSRF guard resolves each hop once, checks every answer and opens the socket to that exact address; a resolver cannot answer public for the check and private for the connection.
type: decision
status: accepted
created: 2026-10-31
updated: 2026-10-31
---

# ADR 0275 — A guarded fetch pins the address it validated

## Context

`fetchGuarded` is the shared boundary for every model- or handler-controlled URL
the framework fetches: `view_file`, `mountDownload`, the CLI `--output-dir`
downloader and the CLI update check. It refused non-`http(s)` schemes, private and
internal hosts, numeric disguises and a private answer on every redirect hop, and
it documented a remaining gap in its own comment: it resolved the hostname to
check it, then called the global `fetch`, which resolved the same name again.

Between those two lookups a resolver answers freely. A host that answers a public
address to the check and `127.0.0.1` to the connection opens a loopback socket
behind a URL that passed every test — SSRF rebinding. `fetchPinnedDocument` had
closed exactly this for the CIMD document path by opening the socket itself; the
streaming path had not, and it is the one a product uses for media.

## Decision

**One resolution per hop, and the socket opens to that answer.**
`fetchGuarded` resolves each hop once, checks every record, and hands the chosen
address to `requestPinned`, which opens `node:http`/`node:https` to that address.
The `Host` header keeps the URL's host and, over TLS, `servername` keeps the name
the certificate is verified against, so pinning does not weaken TLS. The body
stays a Fetch `Response` — a `ReadableStream` over the socket with backpressure
and cancellation — so streaming, the header and body deadlines, the byte caps and
the output-dir containment behave exactly as before.

**Credentials in a URL are refused.** A pinned socket addresses an IP while the
`Host` header names the original host, and a redirect may name another host
entirely; neither is a place to move a `user:password@` pair into. Refusing is the
honest answer, and `fetchPinnedDocument` already refused them.

**`allowPrivateHosts` widens the address check, not the number of lookups.** The
trusted-network opt-in still accepts a private address, and the connection still
uses the single answer it validated.

**`fetchPinnedDocument` uses the same hop.** The buffered document path and the
streaming path share one resolution and one pinned transport; only how the body is
consumed differs (bounded buffer versus stream). Two implementations with
diverging guards is how one of them silently loses a check.

**The resolver is a seam.** `GuardedFetchOptions.dns` and `.transport` exist for
tests: a controlled resolver proves which address the socket went to, and a
transport stub proves a redirect hop is validated before any socket for it is
opened. Neither seam is exported from a public entrypoint.

## Alternatives

- **Keep the two lookups and shorten the window.** Rejected: a window is the
  defect; the whole point is that no second answer exists to use.
- **A custom `lookup` passed to the global `fetch`.** Rejected: neither the WHATWG
  `fetch` nor its Node/Bun drivers accept one, so it would be a shim per runtime.
- **Re-resolve inside a socket factory and check there.** Rejected: the check
  belongs where the policy is, and a factory checking again would accept a second
  answer nobody validated against the URL's host rules as one story.

## Consequences

- `view_file`, `mountDownload`, the CLI downloader and the CLI update check are
  pinned without a change at their call sites.
- A URL with credentials in it is now refused where it used to be silently
  forwarded; no consumer in this repository relies on that.
- The guard is a small internal module pair (`secure-fetch` for policy,
  `pinned-http` for the socket); a future transport (an HTTP proxy, IPv6-only
  hosts) changes the transport and leaves the policy alone.
- Tests pin the property rather than the mechanism: a resolver that answers
  public then private never opens a socket to the private answer, on any hop,
  and a broken pinning makes those tests red.

Serves **I10** (a bounded, declared network boundary), **I13** (only observed
facts decide what is reachable) and **I14** (a security boundary change ships
marked, with its migration).
