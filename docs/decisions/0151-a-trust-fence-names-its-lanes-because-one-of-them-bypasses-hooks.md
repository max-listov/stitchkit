---
title: A trust fence names its lanes, because one of them bypasses hooks entirely
description: createTrustFence compares the requested authority against a declared list at two admission points — the HTTP onRequest hook and the Socket.IO allowRequest policy — because the socket lane never reaches the hook on either runtime.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0151 — A trust fence names its lanes, because one of them bypasses hooks entirely

## Decision

`createTrustFence({ trustedHosts })` compares the authority a request addressed
against a declared list, and refuses with a bare 403 before anything is
dispatched. It exposes **two** admission points, and installing only one leaves
the server half-fenced:

- `fence.hooks` → the server's `hooks.onRequest`, which runs before routing.
- `fence.allowRequest` → `socket.allowRequest`, the Socket.IO engine's own
  admission policy.

## Why two, stated as a measurement rather than a preference

`/socket.io/*` never reaches `hooks.onRequest` on either runtime, and this was
verified in the source rather than assumed:

- **Bun** — the fetch handler answers the socket prefix and returns before
  `admittedFetch`, which is where `createHandler` (and therefore every lifecycle
  hook) lives.
- **Node** — `socket.attach(nodeServer)` hands the `upgrade` event to Socket.IO
  directly, so the fetch handler never sees the handshake at all.

A fence installed only in `hooks` therefore fences the request lane and leaves
open the lane a live application actually pushes its data over. `allowRequest`
is the one slot applied on both runtimes, it receives a real `Request`, and it
runs on every engine request including the upgrade.

`SocketIOHandshakeConfig.verify` was the obvious-looking alternative and is the
wrong slot three times over: it is optional, so a server without it has no fence
at all; it returns an identity rather than a decision; and it is registered as
`io.use()`, which runs *after* the handshake has been admitted.

## What it refuses, and what it deliberately does not

Refuses: a missing `Host`; a `Host` that is not in the list or is not a readable
authority; an `Origin` that disagrees with the `Host` it was sent to; a
`sec-fetch-site: cross-site`.

Does **not** do two things it might be expected to:

- **It does not gate operations.** "Only from this machine" is a property of an
  operation, and an operation is known after routing, not before it. Expressing
  it in the fence would mean matching route prefixes a second time, in a second
  router, ahead of the real one. It belongs in an auth rule over `ctx.ipAddress`
  — `isLoopbackAddress` ships for that — where it composes with every other rule
  and commits in the same transaction (→ ADR 0094).
- **It does not re-check an open connection.** Both lanes check at admission.

## Three details that are easy to get wrong and are therefore pinned

- **It reads the `Host` header, not `new URL(request.url).host`.** The Node
  Socket.IO lane synthesises its `Request` from raw headers and falls back to
  `localhost` when `Host` is absent, so reading the URL would turn a missing
  header into the most trusted authority there is. The headers travel verbatim;
  the URL does not.
- **A list entry's port is split off before the URL parser sees it.** The parser
  drops a default port, so `example.com:80` parsed whole would widen to "any
  port" — an entry meaning strictly more than it says.
- **Every refusal answers identically.** A 403 that said *which* rule refused
  would let a caller learn the trusted list one guess at a time. The reason goes
  to `onRefused` and the log, where the operator is.

## Route groups can no longer declare `onRequest`

Found while placing the fence: `RouteGroup.hooks` accepted an `onRequest` that
the framework never dispatched — it typechecked, it ran, and it fenced nothing.
It is the seventh instance of this repository's most repeated defect, and the
fifth was the neighbouring field of the same interface.

The repair is not to dispatch it. `onRequest` runs before routing, and a group is
only known after routing, so honouring a per-group `onRequest` would require the
second router described above. An option that cannot be honoured must not be
expressible: `RouteGroup.hooks` is now `Omit<LifecycleHooks, 'onRequest'>`, and a
JavaScript consumer gets the same answer as a refusal at startup.

## Consequences

- A server that configures `cors` answers an `OPTIONS` preflight before
  `onRequest`, so the fence does not see it. The preflight carries no operation
  and no body, and the DNS-rebinding attack this exists for is same-origin and
  sends none — but the fence's HTTP lane starts at the request, not at its
  preflight, and the guide says so.
- The fence proves exact authority matching on the lanes it is installed on. It
  cannot prove "protected from DNS rebinding", which also depends on whether a
  reverse proxy passes `Host` through and whether the socket lane was fenced.
- `trustedHosts` has no implicit loopback entry. Trusting `localhost` because it
  looks harmless would be the fence widening itself for a case nobody wrote down.
