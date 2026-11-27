---
title: "ADR 0330: A contract operation declares its refusals, and the server holds it to them"
description: "An endpoint lists the defineErrors factories it refuses with in `refuses`; the server turns an undeclared application code into INTERNAL_SERVER_ERROR on every transport, the typed client narrows a rejection with `refusal(error)`, and MethodDef, OpenAPI, the surface manifest and the fingerprint carry the declaration."
type: decision
status: accepted
created: 2026-11-27
updated: 2026-11-27
---

# ADR 0330: A contract operation declares its refusals, and the server holds it to them

**Relations:** Extends [ADR 0058](0058-zod-first-domain-error-definitions.md) (domain error definitions) and [ADR 0288](0288-an-unrouted-call-is-an-unknown-operation-and-a-contract-has-a-fingerprint.md) (the contract fingerprint); changes no earlier decision. Serves **I1**, **I2**, **I9** and **I13**.

## Context

A contract declared what an operation accepts and returns, never what it refuses with. A
consuming project with a session API branched on `NOT_IDLE` and `MIN_AWAKE` from a shared
`defineErrors` vocabulary; its client compared `err.code` with strings it read from the server
source, and nothing told it when the server started refusing with a new code or stopped using an
old one. The type of `ApiError.code` was `string` on every call, so the compiler could not help,
and the descriptors (OpenAPI, the surface manifest, the contract fingerprint) were silent too.

The vocabulary already held the facts — code, status, message, details schema — and a factory
per code. What was missing was a place on the operation to name the subset it uses, and a rule
that makes the name binding.

## Decision

1. **The declaration is the factories.** `EndpointDef.refuses?: readonly RefusalDeclaration[]`
   takes the factories `defineErrors` returns; each now carries its `code` and `definition`. A
   bare string is refused by the type and by `defineContract` (which also refuses a repeated
   code, naming the endpoint and index), so the list cannot drift from the vocabulary.
2. **The server holds the handler to it.** For an operation that declares `refuses`, an
   `AppError` whose code is neither declared nor a framework code becomes
   `INTERNAL_SERVER_ERROR` (500) with a safe message naming `service.key`, and the original as
   `cause` — the precedent is an output that breaks its schema. The check wraps the handler once
   (`withDeclaredRefusals`, used by `implement` and `implementRemote`), so HTTP, MCP, the agent
   surface, the CLI and a stream that fails mid-way all apply it. Hooks are outside it: a
   `beforeHandle` refusal is policy, not the operation's answer. A failure that is no `AppError`
   keeps its handling; an operation without `refuses` runs unchanged.
3. **The client reads it.** Every typed client method carries `refusal(error)`, typed
   `OperationRefusal<E> | undefined`: the declared codes with `details` typed by their schemas,
   plus the codes any call can end with — `STITCH_ERROR_STATUS` and the new `CLIENT_ERROR_CODES`
   (`UNKNOWN_ERROR`, `STREAM_TRUNCATED`, `STREAM_PROTOCOL_ERROR`). At runtime it checks the brand,
   the code's membership and the details against the schema; anything else is `undefined`, never a
   false type. A test scans `src/` so every code the client raises is in one of the two sets.
4. **The descriptors carry it, only where declared.** `MethodDef.refuses` (resolved: status,
   retryability, message, details schema), OpenAPI `x-stitchkit-refusals` plus one response per
   declared status, an optional `refusals` entry in the surface manifest (the format version
   stays: an absent field leaves old snapshots byte-identical, as `toolView` did), and the
   contract fingerprint, whose digest gains a `refuses` key only for an operation that declares
   it — a contract without declarations fingerprints exactly as before.

## Consequences

- A client switches over `refusal(error)?.code` with typed details, and comparing with a code the
  operation never declared fails to compile.
- A handler that starts throwing a new domain code shows up as a 500 in tests until the contract
  names it; the change is reviewed where the contract is.
- Declaring is opt-in per operation and adds no breaking change: the field is optional, the
  factory type is a subtype of the previous one, and every descriptor is unchanged without it.
- Not decided here: declaring refusals for runtime tools, and generating a per-operation error
  union in OpenAPI beyond the extension.
