---
title: "ADR 0288: An unrouted call is an unknown operation, and a contract has a fingerprint"
description: A server answers an unmatched route with UNKNOWN_OPERATION instead of NOT_FOUND, and a contract fingerprint lets a client read which operations and schemas a server speaks.
type: decision
status: accepted
created: 2026-11-11 13:51 +07:00
updated: 2026-11-11 13:51 +07:00
---

# ADR 0288 — An unrouted call is an unknown operation, and a contract has a fingerprint

Serves **I1**, **I2**, **I9**.

## Context

A client and a server are built from the same contract, but not at the same moment. A package
ships a typed client to its consumers while the server it talks to updates on its own schedule,
so a client of version N regularly calls a server of version N−1.

Three facts then looked alike. A call to an operation the older server lacks was answered
`404 NOT_FOUND` — the code a handler uses for "this object does not exist". A field the older
server does not send was indistinguishable from a field with no value. And nothing let the client
ask which contract the server was built from: the Socket.IO handshake has a place to compare a
protocol identity, the contract client over HTTP and a Unix socket had none.

## Decision

**The router's refusal has its own code.** A request no route matches is answered
`404 UNKNOWN_OPERATION` with `details: { method, path }`. `NOT_FOUND` belongs to handlers. A
contract client adds `details.operation` (`prefix.key`), and reports the router's `405` for its
own call under the same code: it always calls with the method its contract declares, so "this
path exists under another method only" is the same fact to it. The router's `405` says it is the
router's — `details: { method, path, allow }` — so a `METHOD_NOT_ALLOWED` a handler throws
itself stays what it is. The surfaces that route by name rather than by path answer alike: an
unknown command to the in-process CLI invoker, an unknown `--wait` target and an unknown name to
the tool invoker are `UNKNOWN_OPERATION` too, so the code means one thing everywhere.

**A contract has a fingerprint.** `contractFingerprint(contracts)` digests every operation HTTP
carries — method, route, and the JSON Schemas of params, input, output and stream item — into one
value for the set and one per operation. It is synchronous and uses the 128-bit identity digest
the package already has, because a fingerprint identifies and does not authenticate, and Web
Crypto is absent outside a secure context. It covers what constrains a value: descriptions,
annotations, the order of an object's fields and handlers do not move it.

**The identity is read through a contract.** `contractIdentityContract` is an ordinary contract
with one operation; `withContractIdentity(services)` returns the services to mount together with
the one that answers it with their fingerprint — one list, so the identity cannot describe other
services than the server mounts — and `readContractIdentity(contracts, client)` returns the
client's and the server's fingerprints as a value. Every transport that carries a contract carries the identity,
with no second protocol. The server mounts it by choice, since the answer lists operation names.

**Stitchkit compares nothing.** As with the Socket.IO protocol identity (ADR 0002), what a
difference means — refuse, degrade, warn — is the application's decision; the framework computes
both sides and returns them.

## Consequences

Code that read `NOT_FOUND` to mean "no such route, command or tool" reads `UNKNOWN_OPERATION`; the migration
`unknown-operation` shows the change. Routing alone still cannot separate every case: a new
`GET /items/search` reaches an older server's `GET /items/:id` and returns that handler's
`NOT_FOUND`. A client that must know reads the fingerprint instead of inferring from a refusal.
A server older than this decision answers the identity operation with a `404`, which
`readContractIdentity` returns as `server: undefined`.
