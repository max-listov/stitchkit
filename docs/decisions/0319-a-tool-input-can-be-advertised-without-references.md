---
title: "ADR 0319: A tool input can be advertised without references, recursion unrolled to a declared depth"
description: "inputRecursionDepth writes every $ref of a model-facing input document out in place, unrolls each recursive definition the declared number of levels and closes the last level with an open node that accepts every JSON type the definition accepts; a surface declares it, a tool's tool.inputRecursionDepth wins, runtime tools take the surface's projection."
type: decision
status: accepted
created: 2026-11-24
updated: 2026-11-24
---

# ADR 0319 — A tool input can be advertised without references, recursion unrolled to a declared depth

Serves **I1**, **I3** and **I9**. Builds on [ADR 0050](./0050-presentation-schema-is-not-a-parser.md)
(the presentation widens, it never parses) and [ADR 0196](./0196-a-tool-answer-is-a-declared-view.md)
(tool options are one `tool` group).

## Context

Zod writes a recursive schema — `z.lazy`, and `z.json()` itself — as a definition that refers to
itself, and the presentation keeps it as `definitions` plus `$ref`. Model providers read such a
document in three different ways, measured on one consuming project's real surface on 2026-11-24:

- some refuse the whole request when any tool carries a reference cycle (`ref loops … of required
  fields`, `Recursive JSON schemas are not currently supported`);
- some accept the request but never read a definition reached through the `allOf: [{ $ref }]`
  wrapper Zod writes beside a described reference: with that document a model invented the argument
  format in every run, with the same definition written in place it called the tool correctly;
- every provider tried accepted a document with no `$ref` at all, whatever the open node at its end
  (`{}`, `{ type: 'object' }`, `{ type: 'object', additionalProperties: {} }`).

How deep to write a recursion out is not a size question. A provider limits nesting from above (one
refused more than ten levels of `properties` and `items`), and a model forced to call the tool needs
enough levels from below to see the shape of a nested argument: one level gave empty operands, three
gave the correct formula. Only the author knows which tools need which depth.

Runtime tools, discovered tools among them, were projected without the surface's options at all:
`flattenUnionInput` reached contract tools only.

## Decision

1. **One option, a number.** `inputRecursionDepth` on every surface that shapes inputs (`mountAgent`,
   `mountMcp`, `buildMcpServer`, `createMcpHandler`, `validateMcpSchemas`, `buildToolManifest`,
   `describeToolCatalog`, `collectTools`, `createToolInvoker`, the deferred agent surface and the
   surface manifest) writes the input document with no `$ref`, no `definitions` and no `$defs`.
   Absent, the document is the one written before: references stay. A value that is not a positive
   integer is refused where it is declared.
2. **Depth counts definitions on a path.** A recursive definition — one that can reach itself through
   references — is written out at most `N` times along any path from the root; the root of a document
   whose root recursion is `$ref: '#'` counts as its first time. A reference that is not part of a cycle
   is always written out, whatever `N`. So depth 1 shows one level of a formula, depth 3 a formula of
   three nested calls.
3. **The open node widens.** The reference that would write a definition once more becomes a node
   typed by every JSON type the definition can take, read from its `type`, `const`, `enum` and
   combinators: `{ type: 'object' }`, `{ type: 'array', items: {} }`, a scalar type, an `anyOf` of
   these, or `{}` when nothing is readable. It carries the definition's `description` and no other
   constraint, so every value the definition accepts is accepted by the document (ADR 0050), and a
   typed node in a property position adds no path to `findUntypedProperties`.
4. **The wrapper goes with the reference.** A reference written out beside annotations only
   (`description`, `title`, `default`, …) merges into one node, the use site's annotations winning;
   beside any other keyword the conjunction stays as an `allOf` with the written-out branch.
5. **References are written out before flattening**, so a discriminated union reached through a
   reference is flattened like one written in place.
6. **A tool can declare its own depth** in its `tool` group: `tool.inputRecursionDepth` wins over the
   surface's value, and projects that tool on every tool surface even where the surface declares none
   — it is a statement about this tool's input. Runtime tools take the surface's value.
7. **Runtime tools take the surface's input projection**: `flattenUnionInput` and
   `inputRecursionDepth` reach them on every surface, MCP included. A tool discovered from a server is
   a runtime tool, so a served reference cycle can be projected away on the client's own surface.

## Consequences

- A surface whose provider refuses recursion sets one constant; a tool whose model needs more levels
  says so beside its name and view. Execution is unchanged: the handler parses the contract's own
  recursive schema.
- A served projected document is read back by the discovered-schema boundary with the open nodes as
  written, so a value deeper than the depth still reaches the server, which judges it.
- `allowUntyped` paths written for a property inside a definition change with the projection:
  without it the property was reported from the definition's root, with it from the full path.
- Each level multiplies the document by the number of back edges in a definition; the depth is the
  declared bound, and `describeToolCatalog({ maxSchemaBytes })` measures what it costs.
