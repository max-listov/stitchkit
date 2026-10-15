---
title: "ADR 0260: Proxy origin trust is separate from client IP"
description: "One explicit native ingress policy restores the external scheme before composition without changing host authorization or losing Bun request identity."
type: decision
status: accepted
created: 2026-10-16 05:06 +07:00
updated: 2026-10-16 05:06 +07:00
---

# ADR 0260 — Proxy origin trust is separate from client IP

**Invariants:** I6, I8, I9, I12, I13.

## Context

A TLS terminator forwards plain HTTP while browser Origin and Referer retain HTTPS.
A correct same-origin check refuses that mismatch. Trusting client-IP headers does
not establish trust in a replacement URL. Normalizing after a fetch wrapper is too
late for host-based composition, and copying a Bun Request loses its native socket
association: requestIP returns null and upgrade refuses the copied request.

## Decision

The Bun adapter owns `proxyOrigin: { trustedPeer }`, independently of `trustProxy`.
The predicate sees the real TCP peer. A trusted request requires a single lowercase
HTTP/HTTPS X-Forwarded-Proto and a valid wire Host. Forwarded, X-Forwarded-Host and
X-Forwarded-Port are refused when present. An ingress must overwrite Host and proto
and strip the competing headers. Untrusted traffic retains its original Request.
There is no multi-hop header parser or implicit forwarded-host fallback.

The adapter normalizes before managed fetch composition and Socket.IO dispatch. A
WeakMap relates each normalized Request to its original native Request. The actual
Bun runtime handle's requestIP, timeout and upgrade methods translate that mapping;
all other server methods, native upgrades and lifecycle tracking keep their owning
runtime. The Request constructor preserves body, method, headers and linked abort
signal, and clones carry the external URL. No native Request URL getter is patched.

Host/tenant authorization remains in the application. SNI/Host validation belongs to
the TLS terminator, because a plain HTTP listener cannot observe TLS SNI. Consumers
retain exact same-origin checks; no HTTP/HTTPS alias or relaxed cookie policy is
introduced. The policy is not offered on the Fetch-clean handler or Node adapter
without a corresponding native identity mechanism and consumer evidence.

## Consequences

Wrappers, hooks, contracts and raw routes share the same normalized URL. Port numbers
come from the wire authority, preserving an explicit :80 over external HTTPS. Default
traffic and the client-IP trust contract retain their existing behavior. Native TCP,
cancellation, clone, WebSocket and managed shutdown controls exercise the runtime
boundary; the installed-package server lane exercises the same public composition.
