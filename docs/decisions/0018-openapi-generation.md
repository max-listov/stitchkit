---
title: "ADR 0018 — OpenAPI generated from the contract"
type: decision
status: accepted
created: 2026-05-29
updated: 2026-05-29
---

# ADR 0018 — OpenAPI generated from the contract

- **Status:** Accepted
- **Date:** 2026-05-29

## Context

A `defineContract` already carries the full type information for the HTTP
surface — Zod `params` / `input` / `output`, `desc`, `method`, `path`, `scope`.
An OpenAPI document is that information re-expressed. Hand-maintaining a separate
spec (or decorating handlers) duplicates the contract and drifts from it.

The CLI transport's `--help` walker (ADR 0016) needs the same thing the spec
needs: a Zod → JSON Schema conversion and a way to read an object schema's
top-level properties. Building two divergent walkers would be the duplication
rule's exact failure mode.

## Decision

**Generate OpenAPI 3.1 from contract services; share the schema traversal with
the rest of the framework.** `generateOpenApiDocument({ info, services, groups })`
returns a `{ openapi: '3.1.0', info, paths }` document.

- A method is included when it is HTTP-exposed — `expose` absent, or `expose`
  includes `'HTTP'` — the **same rule the router uses to build routes**, so the
  spec and the live routes never disagree about what exists.
- `path` params come from `paramsSchema` (`in: 'path'`); a GET's `inputSchema`
  becomes query parameters; a non-GET's `inputSchema` becomes a JSON
  `requestBody`; `outputSchema` becomes the `200` response; `scope` (when not
  `public`) adds `401` / `403`.
- Conversion goes through the **single** `toJsonSchema` point and the shared
  `jsonSchemaFields` helper — the same two functions the CLI `--help` walker
  uses. An unrepresentable construct degrades to `{}` rather than throwing the
  whole document, mirroring `buildToolManifest`.
- `openApiRoute('/openapi.json', doc)` is a `RawRoute` that serves the document.

Schemas are **inlined**, not de-duplicated into `components/$ref`. Inlined output
is valid OpenAPI and keeps v1 simple; `$ref` de-dup can come later if a spec
grows unwieldy.

## Consequences

- The OpenAPI spec is free and always in sync — the contract is the single
  source, no decorators, no parallel document.
- The schema-introspection code has one home: `tools/json-schema.ts` powers the
  MCP manifest, the CLI `--help` table and the OpenAPI document alike.
- Typed path-param inference from the path literal (Hono-style) and `$ref`
  de-duplication are explicitly deferred.
