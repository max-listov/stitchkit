---
title: MCP multi-round tool runtime
description: Typed input-required rounds, signed continuation state and runner semantics.
type: architecture
status: active
created: 2026-08-09
updated: 2026-08-09
---

# MCP multi-round tool runtime

## Declaration and execution

An operation opts in with an ordered `mcp.inputRequired` array. Every item has a
unique stable key, human message and Zod object schema. Contract and runtime
definitions use the same runner. The initial attempt asks for item zero; every
accepted continuation advances exactly one item. The operation handler is not
invoked until all items are accepted, when one exact typed aggregate is exposed
as `ctx.mcpInput[key]` and the final output is validated.

`multiRound.serving.maxRounds` is a hard definition boundary (default `10`). An
empty sequence, duplicate key or declaration above the limit fails first. The
accepted aggregate is carried only inside signed continuation state; callers
cannot inject an earlier answer through ordinary arguments.

## State security

`multiRound.state` supplies one HMAC key, expiry and authenticated principal
resolver. The sealed state binds principal, full operation identity (tool name,
service, action, method and scope), round index, accepted aggregate and a
canonical digest of the original arguments. Continuations with modified data,
expired state, another principal, another operation or mismatched original
arguments fail before side effects.

The token prevents tampering but is not an exactly-once replay store. Operations
that cannot tolerate host retries remain responsible for application-level
idempotency.

## Lifecycle and compatibility

Every attempt gets a fresh request/tool context and re-runs auth and lifecycle.
Each completed attempt emits its own hooks/audit record with `mcp.outcome` and
`mcp.round`; guard attempts do not run the operation side effect, and output
validation applies only to the final result. Concurrent flows share neither
context nor continuation data. These records are per-attempt: Stitchkit does not
invent one logical trace spanning several HTTP requests.

Modern HTTP/stdio hosts and the official supported legacy stdio bridge may use
MRTR. Unsupported eras receive an explicit unsupported outcome and are not told
they have a capability they cannot execute. Agent, CLI and ordinary HTTP calls
remain single-round and their handler types do not gain MCP input.
