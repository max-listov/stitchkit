---
title: Path literals materialize string params
description: A named path segment is both a type-level input and a runtime validation schema; an explicit params schema may refine it but must cover it.
type: decision
status: accepted
created: 2026-09-06
updated: 2026-09-06
---

# 0168 — Path literals materialize string params

## Decision

Every named segment and terminal wildcard in an endpoint path is parsed once by
the contract layer. When `params` is omitted, Stitchkit materializes a Zod
object whose fields are strings and exposes the same shape through handlers,
typed clients, OpenAPI, MCP, CLI and the surface manifest. An explicit `params`
schema remains the only way to coerce or further validate values, and it must
cover every segment present in the path.

## Why

The path already declares the names. Repeating a string-only Zod object at
hundreds of endpoints added no information, while type-only inference would
have left runtime validation and generated surfaces disagreeing with the
TypeScript API. A single canonical parser keeps all projections in phase.

## Consequences

- `PathParams<P>` describes the inferred TypeScript shape.
- A path with segments and no explicit `params` no longer behaves like an
  unvalidated raw-parameter endpoint; this is a breaking correction.
- Coercion, UUID checks and other refinements stay explicit.
- Missing segment coverage is rejected when the contract is defined.
