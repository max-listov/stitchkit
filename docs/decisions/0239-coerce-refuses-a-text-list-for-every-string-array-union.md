# 0239 — A list written as text is refused for every string-or-array field

**Status:** Accepted
**Date:** 2026-10-05

Amends ADR 0218. Invariants I2, I3, I8 and I13.

## Context

A field typed `z.union([z.string(), z.array(z.string())])` takes one value or a list. When a model
or a shell sends the list as JSON text, `'["a.png"]'`, the string member matches, and the value is
read as one wrong name. The shared coercion keeps strings in a string-bearing union on purpose:
parsing JSON first would turn identifiers such as `"123"` or `"null"` into another branch.

ADR 0218 closed this for one tool: the `view_file` input schema refused a list written as text. Every
other string-or-array field of every consumer contract kept the silent misread, and the refusal
lived in one tool's schema instead of in the mechanism that decides how strings are read.

## Decision

`coerceValue` (`packages/core/src/tools/schema/coerce.ts`) owns the refusal. When a union has a
string member, the string is kept as a string, except that a string which parses as a JSON array
the union's array member accepts is refused by name:
`<path> is a list written as text — pass the array itself, not JSON written as text`. The path is
the field's path at any depth. The refusal is a validation error on every surface that coerces
arguments: managed MCP, agent and CLI tools and raw MCP through `coerceJsonArgs`.

A string that is not a list the array member accepts stays one plain value: `[preview].png`, a
truncated `[1,2`, a list of objects for a string array, a list longer than the array's `max`.

`view_file` has no private check. Its schema is a plain string-or-array, and the shared rule covers
it. ADR 0218's decision for `view_file` — a mistaken list is refused before any IO, with a hint, and
the shared coercion does not parse it into an argument — still holds; where the refusal is made
changes.

## Consequences

Parsing `ViewFileInputSchema` directly no longer refuses a list written as text; the refusal happens
in `coerceJsonArgs`, which every tool surface runs. A list written as text as an *element* of a
string array is not seen by the rule, because the element is a plain `z.string()` with no union.

A consumer whose contracts hold a string-or-array field starts refusing the text form that was read
as one name. The migration is to send the array. The change is recorded as a breaking item for
`stitchkit/tools` and `stitchkit/cli` with its migration in `docs/guide/upgrading.md`.

## Verification

`tool-extensions.test.ts` covers the refusal by name at any depth, the strings that stay one plain
value, and the validation error on every tool surface. `managed-view-file.test.ts` runs `view_file`
through the shared rule.
