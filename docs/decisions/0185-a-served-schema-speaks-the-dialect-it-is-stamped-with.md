---
title: "ADR 0185: A served schema speaks the dialect it is stamped with"
description: "The MCP mount emitted draft-07 definitions under a 2020-12 stamp, so our own MCP client could not resolve a single pointer; the document now matches its label, the definitions are hoisted to the root, and a round-trip test holds both halves together."
type: decision
status: accepted
created: 2026-09-16
updated: 2026-09-16T14:14+07:00
---

# ADR 0185 — A served schema speaks the dialect it is stamped with

## Context

A consumer tried to build a CLI whose commands come from a running server — the
composition the CLI surface exists to support — and `mountConnections` threw
before returning a single definition:

```
Error: Reference not found: #/definitions/input/definitions/__schema0
```

Both sides of that sentence were ours: the MCP mount wrote the schema and the
MCP client refused to read it. On one real surface of 205 tools, five carried
such a reference. The mount is all-or-nothing, so the whole connection failed.

Two separate defects sat underneath, and only one of them is the one the error
names.

**The dialect.** `buildToolPresentationSchema` emits draft-07, whose reusable
subschemas live under `definitions`. `presentationMetadata` strips `$schema`
because "the SDK supplies its own dialect" — and the SDK's own dialect is
2020-12, whose keyword is `$defs`. The served document therefore declared
2020-12 and used draft-07's keyword. A reader registers reusable subschemas from
the keyword its declared dialect names, so it registered `$defs` (empty) and then
could not resolve `#/definitions/x` at all. Measured: the identical document
converts cleanly when `$schema` says draft-07 and fails when it says 2020-12 or
says nothing. Nesting was never the cause; it was the thing the error message
happened to point at.

**The nesting.** `namespaceLocalReferences` kept params' and input's local
references apart by wrapping each schema in a per-namespace `definitions` entry,
producing `definitions.input.definitions.__schema0`. That is a valid JSON Pointer
target and an unreadable one: a reader that registers top-level definitions —
which is what a dialect describes — never looks one level deeper.

## Decision

1. **The document matches its stamp.** `presentationMetadata` moves the
   top-level `definitions` to `$defs` and carries its pointers with it, because
   2020-12 is what the SDK stamps on what it is handed. Only the top level
   moves: a `definitions` deeper in a document may be a property literally called
   "definitions", and guessing which is worse than leaving it alone.
2. **Definitions are hoisted to the document root.** A namespace becomes a
   *prefix on the name* (`input__schema0`) instead of a wrapper, so every pointer
   resolves against the root in one step. An `allOf` merge lifts both branches'
   definitions up with it for the same reason.
3. **The client does not believe a contradicted stamp.** A discovered document
   that declares 2020-12 (or declares nothing) while carrying `definitions` and
   no `$defs` is reconciled before conversion. This is not politeness toward
   foreign servers: it is how a consumer reaches every stitchkit server published
   before this release, none of which it can upgrade.
4. **One unconvertible tool does not take the connection down.** The mount builds
   per tool, skips what it cannot build and names it (`onSkippedTool`, or a
   stderr line). A surface of 205 tools is not lost to one schema.

## Consequences

The served bytes change: `definitions` becomes `$defs` and nested blocks become
prefixed top-level ones. Both documents describe the same schema, and the new one
is resolvable by readers that only register what the dialect names — which is
most of them, ours included.

Nothing in the repository asserted that our MCP output and our MCP client agree;
that is how a defect this mechanical survived. `packages/core/tests/mcp-schema-round-trip.test.ts`
mounts a contract, reads the served schema and converts it back, and pins the
dialect against the keyword. It fails if either half changes its layout without
the other.

The wider lesson has nowhere else to live, so it goes here: **a document that
names one dialect and uses another's keyword is not a style question.** It is a
document that says one thing and does another, and every reader that believes it
is wrong in the same way at the same place.
