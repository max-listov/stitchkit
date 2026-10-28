---
title: "ADR 0272: A restored string format is judged by its server"
description: "Foreign JSON Schema carries string checks without the author's error messages; the original remote schema owns those refusals."
type: decision
status: accepted
created: 2026-10-28 19:56 +07:00
updated: 2026-10-28 19:56 +07:00
---

# ADR 0272 — A restored string format is judged by its server

**Invariants:** I2, I3, I8, I13. Extends [ADR 0266](0266-a-discovered-schemas-unions-are-judged-by-its-server.md).

## Context

MCP and OpenAPI connections restore foreign JSON Schema into Zod before invoking a tool.
JSON Schema represents string formats and patterns, but it does not carry the original
schema's error messages. An original UTC datetime schema can explain that a bare date
needs a full timestamp and give an example; its restored copy substitutes `Invalid ISO
datetime`. A generated datetime document can carry both `format` and `pattern`, producing
two synthetic format refusals for the same field. Refusing before dispatch prevents the
server from supplying the precise answer it already owns.

ADR 0266 assigns restored unions to the remote for the same reason: a presentation is
not the original contract. String formats need that existing ownership boundary too.

## Decision

The common foreign-schema boundary marks the restored root object with nonenumerable
global-symbol provenance, shared across independently bundled entrypoints. The existing
local verdict excludes `invalid_format` as well as `invalid_union` only for marked schemas.
This covers JSON Schema `format` and `pattern`, including nested fields and record values.

A record-key `invalid_key` wraps its reasons. The same selection descends into that
container: no local reasons means the wrapper is deferred; otherwise its original path,
origin and message remain with only the local children. Changed child identities count
as a changed verdict even when the number of root issues is unchanged. Unchanged issues
and errors keep their identity. Union alternatives remain one remote-owned refusal.

Every other reported issue remains local, including wrong types, missing fields, unknown
keys, enum values, string lengths and numeric or collection bounds. A wholly deferred
refusal sends the existing coerced arguments, without locally materialized defaults or
partial parse output. The remote validates and its ordinary response policy applies:
MCP relays its refusal envelope; OpenAPI retains its HTTP error projection. Schemas authored
locally retain their entire verdict and execute their own transforms/refinements once.

## Consequences

A foreign format or pattern refusal costs a remote call, and the remote must enforce its
own contract. The client does not weaken schemas, reparse to recover checks that Zod did
not reach, add a vendor schema keyword or expose a new configuration flag. A structural
failure reported alongside a format still prevents dispatch without synthetic format noise.

Source regressions exercise the actual MCP server and CLI, plus OpenAPI dispatch and the
pure verdict boundary. An installed-archive proof crosses the separately bundled public
connection, CLI and MCP entrypoints on Bun and Node.
