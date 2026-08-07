---
title: "ADR 0047 — One MCP schema validation profile"
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0047 — One MCP schema validation profile

- **Status:** Accepted — completes the schema-parity rule of
  [ADR 0014](0014-tool-http-parity.md) and the advertised-schema guarantees of
  [ADR 0034](0034-advertised-schema-key-policy.md)
- **Date:** 2026-08-07

## Context

Standalone schema validation used four positional arguments and required the
consumer to repeat the mount's extension and flattening settings. The live
handler ran only the base compatibility probe. A project could therefore pass a
build-time check over one schema and publish a different one, while stricter
typed-property and format rules lived outside the handler configuration.

## Decision

MCP validation has one `McpSchemaValidationConfig`: compatibility `policy`,
typed-property enforcement/allowlist and portable-format enforcement/allowlist.
`validateMcpSchemas` accepts one object that combines this profile with
`services`, `logger`, `extend` and `flattenUnionInput`.

Every live MCP config carries the profile as `schemaValidation`. The handler and
mount own the schema-shaping options and apply the profile after extension and
union flattening. Static services validate when the handler is constructed;
identity-dependent service factories validate when their server is built.

The positional signature and `onIncompatibleSchema` field are removed. No
overload, alias or compatibility adapter remains.

## Consequences

- Validation and mounting share one preparation path and issue vocabulary.
- A strict profile cannot accidentally inspect a different schema from the one
  a client receives.
- New validation dimensions become named profile fields rather than more
  positional arguments or parallel handler settings.
- Custom formats are reported, never deleted or rewritten. An allowlist means
  the operator asserts every client understands that format.
- The 0.37.0 migration is breaking but mechanical.
