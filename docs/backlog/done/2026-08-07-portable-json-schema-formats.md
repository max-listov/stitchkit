---
title: Portable JSON Schema format validation for MCP
description: Detect non-portable schema formats before MCP clients or SDK validators encounter them.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 06:41 +00:00
related: docs/backlog/planned/2026-08-07-mcp-schema-validation-profile.md
---

# Portable JSON Schema format validation for MCP

> **Target release:** 0.37.0. Detection is strict and explicit; stitchkit does
> not silently strip formats or weaken validation.

## Problem

Zod-specific schemas can publish custom JSON Schema formats such as `cuid2`.
MCP clients commonly validate with format registries that do not know them,
producing warnings or incompatible behaviour even when a pattern is also
present. The incompatibility should be found while preparing the MCP surface.

## Implementation plan

1. Define and document the portable-format baseline from JSON Schema 2020-12
   and the formats supported by the MCP SDK validation path. Keep it as one
   named internal source of truth with focused tests.
2. Implement a deep JSON Schema walker covering properties, array items,
   additional properties, definitions/references and composition branches.
   Report the tool, input/output location, property path and offending format.
3. Add `requirePortableFormats` and explicit `allowFormats` to the canonical MCP
   schema validation profile. Unknown formats fail with an actionable message:
   use a portable pattern/schema or explicitly allow a configured client format.
4. Run the check on the final prepared schemas after extension and union
   flattening, for both contract and framework-owned native tools.
5. Add exact regression fixtures for `z.cuid2()` and nested custom formats,
   plus portable standard formats and an explicitly allowed custom format.
6. Document the rule and migration examples. Do not delete `format`, invent a
   mapping, or treat `pattern` as permission to ignore an incompatible format.

## Acceptance

- [x] Custom `cuid2`, `cuid` and `ulid`-style formats are detected with precise paths
- [x] Standard portable formats pass without configuration
- [x] Nested and composed schemas are traversed completely
- [x] Explicitly allowed formats pass and remain present in the advertised schema
- [x] The same result is produced by standalone validation and handler preparation
- [x] No validation keyword is silently removed or rewritten

## Что сделано

- [x] **Validator:** `packages/core/src/tools/portable-formats.ts` defines the
  JSON Schema/AJV portable baseline and a deep walker across properties, arrays,
  maps, definitions, conditionals and composition branches.
- [x] **MCP integration:** `packages/core/src/tools/mcp.ts` checks final input and
  output schemas after extension/flattening under
  `schemaValidation.requirePortableFormats`; `allowFormats` is explicit.
- [x] **Handler parity:** static `createMcpHandler` services use the same profile
  and exact shaping inputs as standalone validation. Identity-dependent services
  go through the same mount preparation when their server is built.
- [x] **Native parity:** raw SDK registrations remain intentionally outside all
  framework validation; applying this profile to framework-owned native tools is
  a required acceptance item in
  `docs/backlog/planned/2026-08-07-framework-owned-native-mcp-registration.md`.
- [x] **Tests:** `packages/core/tests/portable-formats.test.ts` covers standard
  formats, `cuid2`/`cuid`/`ulid`, nested paths, output schemas, ToolExtend,
  handler parity, allowlisting and keyword preservation.
- [x] **Docs:** MCP guide, API reference, changelog and generated LLM docs explain
  the strict rule and the explicit client-capability escape hatch.
- [x] **Gates:** lint/typecheck passed; 41 focused tests, build/public-type guard
  and both packed consumer fixtures passed.
