---
title: The tool presentation schema is not a parser
description: MCP and agent SDKs advertise an immutable JSON Schema through identity adapters while original Zod contracts remain the only executable input parsers.
type: decision
status: active
created: 2026-08-07
updated: 2026-08-07
---

# 0050 — The tool presentation schema is not a parser

## Status

Accepted. Supersedes the executable-advertised-schema premise of ADR 0034 and
the Zod-rebuilding mechanism of ADRs 0031, 0033 and 0044. Their model-facing
flattening guarantees remain in force.

## Context

MCP and AI SDKs parsed the Zod schema Stitchkit supplied for advertisement,
then `executeToolMethod` parsed the SDK result with the original contract. A
transform could therefore run twice; protected native MCP inputs ran three
times. Making the derived flattened Zod schema preserve every runtime semantic
created a large coupling to Zod internals without removing the duplicate parse.

## Decision

- Original contract `params` and `input` Zod schemas are the only executable
  parsers for handler-bound contract data.
- Tool preparation creates one immutable presentation JSON Schema shared by
  MCP, agent tools, manifests, validation and prepared-surface caching.
- `flattenUnionInput` is a pure, conservative JSON Schema projection. It may
  widen branch-specific constraints but cannot transform runtime values. The
  flattened document is a superset of the unflattened presentation document.
- Presentation describes the nominal values a caller should send. Runtime-only
  tolerance such as `z.coerce.number()` accepting `"7"` or `.catch()` recovering
  invalid input stays in the executable parser and is deliberately not widened
  to `{}` in the advertised schema; advertising every tolerated fallback would
  erase useful model guidance.
- MCP receives the document as metadata on an identity `z.looseObject({})`
  carrier. AI SDK receives it through `jsonSchema()` with an identity validator.
- `ToolExtend.schema` remains executable: Stitchkit parses only its own keys
  once inside the shared runner, resolves context, then removes those keys
  before contract parsing.
- Protected native tools use the same carrier and runner. Raw registration
  remains an explicit opt-out.

## Consequences

Strict failures now occur inside Stitchkit and reach tool hooks/audit instead of
being rejected by an SDK before the callback. Loose keys, defaults, coercions,
refinements and transforms reach exactly the original parser. Presentation
flattening no longer depends on private Zod check internals. Identity adapters
also let the runtime parser accept tolerated coercion/catch inputs even when the
nominal presentation tells generated callers to send the canonical type.

`flattenDiscriminatedUnion` and `flattenUnionsDeep` are removed: returning an
executable derived parser would reintroduce the architecture this decision
forbids. `flattenToolJsonSchema` is the presentation-only replacement.
