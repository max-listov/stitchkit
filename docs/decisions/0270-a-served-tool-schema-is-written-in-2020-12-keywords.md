---
title: "ADR 0270: A served tool schema is written in 2020-12 keywords"
description: "The MCP mount translates the draft-07 presentation into 2020-12 keywords — tuples included — because the SDK stamps 2020-12 and a client that validates tool schemas drops a tool whose `items` is a list."
type: decision
status: accepted
created: 2026-10-26 19:20 +07:00
updated: 2026-10-26 19:20 +07:00
---

# ADR 0270 — A served tool schema is written in 2020-12 keywords

**Invariants:** I13. Amends [ADR 0185](0185-a-served-schema-speaks-the-dialect-it-is-stamped-with.md).

## Context

The tool presentation is built in draft-07, the vocabulary the AI SDK converts Zod schemas
in, so an agent tool and its presentation describe a tuple the same way. ADR 0185 made the
MCP document match the 2020-12 stamp the SDK puts on it, but only for reusable subschemas
(`definitions` → `$defs`). A tuple stayed in draft-07 form: `items: [a, b]` with the rest in
`additionalItems`.

In 2020-12 an `items` list is not a schema. A client that validates each tool schema before
offering the tool refuses it, and Claude's MCP loader does exactly that:

> "lights_set" (MCP server "base"): "schema/properties/rgb/items must be object,boolean"

A consuming project lost six tools with `z.tuple` inputs (an RGB triple, a point) this way.
The server logged nothing: the tool was registered and served, only never offered to the
model.

## Decision

The MCP document is written in 2020-12 keywords, not only stamped with them.
`presentationMetadata` passes the presentation through one translation
(`withDraft2020Keywords`, `src/json-schema/dialect.ts`): the top-level `definitions` moves to
`$defs` with its pointers, and at every schema position a tuple's `items` list becomes
`prefixItems` with `additionalItems` becoming `items`. The walk follows schema keywords only,
so a `default`, an example or a property that happens to be called `items` is left as
written.

The stitchkit MCP client applies the same translation to a discovered document that does
not declare draft-07, so a server published before this change is still read with its
tuples' meaning.

The agent presentation stays draft-07: it is handed to the AI SDK, whose own conversion of
the same Zod schema is draft-07.

## Consequences

A tuple-typed tool is offered by Claude's MCP client. Arity, order and the rest element are
enforced as before. `tests/mcp-tuple-schema-dialect.test.ts` validates the served document
with a 2020-12 meta-schema validator, keeps a control showing the refusal Claude reports for
the untranslated document, and walks the document to check that no `items` list remains.
The served bytes of every tuple-typed MCP tool change; no other tool's document does.
