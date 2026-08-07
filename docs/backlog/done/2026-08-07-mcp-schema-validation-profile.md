---
title: Object-shaped MCP schema validation profile
description: Give standalone validation and MCP handlers one canonical schema policy applied to the exact advertised tool surface.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 06:47 +00:00
related: docs/backlog/planned/2026-08-07-portable-json-schema-formats.md
---

# Object-shaped MCP schema validation profile

> **Target release:** 0.37.0. This is a deliberate breaking cleanup: there will
> be one object-shaped API and no positional overload.

## Problem

`validateMcpSchemas(services, policy, logger, options)` is easy to call with an
options object in the wrong position. `createMcpHandler` performs base schema
validation for static services, but it cannot express the stricter typed-field
or portable-format policy and validation can drift from the schemas actually
published after `extend` and union flattening.

## Public model

Define one `McpSchemaValidationConfig` used by both entry points:

```ts
validateMcpSchemas({
  services,
  policy: 'throw',
  requireTypedProperties: true,
  allowUntyped: [],
  requirePortableFormats: true,
  allowFormats: [],
  extend,
  flattenUnionInput,
  logger,
})

createMcpHandler({
  services,
  schemaValidation: {
    policy: 'throw',
    requireTypedProperties: true,
    allowUntyped: [],
    requirePortableFormats: true,
    allowFormats: [],
  },
})
```

The exact property defaults are decided and recorded before implementation.
The handler supplies its real `extend` and `flattenUnionInput` values internally;
consumers must not repeat them inside `schemaValidation`.

## Implementation plan

1. [x] Record the validation-profile/default decision in an ADR and index it.
2. [x] Replace the positional standalone signature with one object parameter and
   migrate all internal and owner-controlled call sites in the same pass. Do not
   keep an overload, wrapper or deprecated alias.
3. [x] Add `schemaValidation` to `McpHandlerConfig`. Validate static services during
   preparation and auth-dependent service factories during server construction.
4. [x] Make validation consume the same immutable prepared descriptors that
   mounting advertises. `extend`, flattening, output schema conversion and
   compatibility probes must have one implementation and one result.
5. [x] Integrate typed-property validation and the portable-format validator from
   its linked task into the same issue model and policy (`throw`, warning or
   explicitly disabled where supported).
6. [x] Apply the same profile to framework-owned native MCP tools so contract and
   native registrations cannot diverge. → Вынесено в связанную задачу
   `2026-08-07-framework-owned-native-mcp-registration.md`, где появляется сама
   framework-owned native surface; raw SDK registrations не имеют framework-схемы.
7. [x] Update API reference, MCP guide, configuration tables, generated LLM source,
   upgrading guide and the 0.37.0 breaking changelog section.

## Acceptance

- [x] The standalone validator accepts exactly one object argument
- [x] `createMcpHandler.schemaValidation` covers typed properties and portable formats
- [x] Validation sees the exact schemas advertised after extension and flattening
- [x] Static services validate once during deterministic preparation
- [x] Auth-dependent services validate against their resolved per-identity surface
- [x] Contract and framework-owned native tools use the same validation profile → native half transferred to and acceptance-gated by `2026-08-07-framework-owned-native-mcp-registration.md`
- [x] Misplaced positional options are impossible at compile time
- [x] Migration docs show the complete before → after call shape

## Что сделано

- [x] **Core:** `packages/core/src/tools/mcp.ts` now defines the single
  `McpSchemaValidationConfig`, object-only `ValidateMcpSchemasConfig`, and the
  shared immutable `prepareMcpSurface` used by validation and mounting.
- [x] **HTTP:** `packages/core/src/tools/mcp-handler.ts` prepares static services
  once at handler construction and resolves factory services per identity.
- [x] **Validation:** typed-property and portable-format guards run after the
  actual `extend` and `flattenUnionInput` shaping.
- [x] **Types:** `packages/core/scripts/consumer-lane/fixtures/full/src/app.ts`
  proves the published object form and rejects the removed positional form.
- [x] **Tests:** `packages/core/tests/portable-formats.test.ts` and
  `packages/core/tests/mcp-preparation-cache.test.ts` cover shaping parity,
  static preparation and identity-dependent preparation.
- [x] **Docs:** ADR 0047, `docs/guide/mcp-and-agents.md`,
  `docs/guide/upgrading.md`, `docs/api/reference.md` and `CHANGELOG.md` describe
  the canonical profile and migration.
- [x] **Native boundary:** implementation is deliberately not duplicated over
  raw `server.registerTool`; the linked framework-native task owns that new
  registration API and must consume this profile before it can close.
- [x] **Verification:** focused MCP tests, lint, typecheck, build, declaration
  guard and both packed consumer lanes passed.
