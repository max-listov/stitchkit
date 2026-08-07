---
title: Decouple flattened tool presentation from contract parsing
description: Replace executable flattened Zod schemas with a presentation-only schema compiler so SDKs cannot mutate tool arguments before the canonical contract parser.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 07:57 +00:00
related:
  - docs/decisions/0031-deep-union-flatten.md
  - docs/decisions/0033-sound-flatten-collisions.md
  - docs/decisions/0034-advertised-schema-key-policy.md
  - docs/decisions/0044-a-collided-field-keeps-its-type.md
---

# Decouple flattened tool presentation from contract parsing

> **Target:** the release after 0.36.1, before publishing 0.37.0.
> This is a separate correctness task inside that release.

## Confirmed root problem

`flattenUnionInput` currently builds a second executable Zod schema. MCP and AI
SDKs parse with it and pass the parsed value into stitchkit, which then parses
again with the original contract schema. A unique variant field carrying
`z.string().transform(v => v + '!')` is therefore transformed twice:

```json
{"raw":"x","afterSdk":"x!","afterRunner":"x!!"}
```

The defect is broader than flattening: every contract `input` / `params` schema
is currently given to the SDK and then parsed again by `executeToolMethod`, so a
normal non-flattened transform can also execute twice. Protected native MCP
tools add a third parse in their handler.

The 470-line `tools/flatten.ts` has accumulated collision widening, key-policy
merging and Zod-internal hidden-check analysis because one derived schema is
being asked to serve two incompatible roles: model-facing description and
runtime parser.

## Decision to validate

Separate the two roles:

1. The original contract Zod schemas remain the **only executable parser** for
   params/input inside `executeToolMethod`.
2. Tool preparation compiles a separate, immutable **presentation JSON Schema**.
3. `flattenUnionInput` transforms that presentation document only; it never
   creates a Zod parser and never changes handler-bound data.
4. MCP and AI SDK adapters advertise the presentation document while forwarding
   raw arguments unchanged into the shared stitchkit runner.
5. No low-level protocol dispatcher, monkey-patch, MCP v2 migration or
   compatibility shim. MCP 1.30 can advertise metadata from an identity
   `z.looseObject({})` carrier while returning the raw object unchanged; AI SDK 7
   exposes `jsonSchema(document, { validate })` for the same split.

## Validated invariants

1. **Raw identity:** a transport adapter returns the same raw JSON object without
   field deletion, defaults, coercion or transforms.
2. **Canonical parsing:** only the original contract params/input schemas create
   handler-bound values, exactly once.
3. **Presentation soundness:** flattening is a conservative lossy join of the
   unflattened presentation document, never a narrower second conditional
   validator. Runtime-only tolerance (`coerce`, `catch`) remains in the original
   parser instead of widening useful model guidance to `{}`.
4. **Extension boundary:** `ToolExtend.schema` is parsed exactly once inside the
   runner before `resolve`; its keys are then removed before contract parsing.

## Implementation plan

- [x] Established the current MCP/AI SDK schema adapter contracts from their
      primary sources and choose the clean supported seam.
- [x] Replaced `MountableTool.schema` as the runtime/parser authority with an
      explicit presentation-schema descriptor while retaining original
      `MethodDef.paramsSchema` / `inputSchema` for execution.
- [x] Implemented deep discriminated-union flattening as a pure JSON Schema
      compiler: discriminator enum, optional variant fields, conditional hints,
      collision widening to a sound shared type or unconstrained schema, and no
      `oneOf` / `anyOf` for flattenable discriminated unions.
- [x] Kept conditions as deterministic description hints only — no `if` / `then`
      or other pre-run conditional validation aimed at weak models.
- [x] Ensured compilation never mutates source Zod schemas or generated shared
      JSON nodes; preserve descriptions and portable object semantics useful to
      the model without reproducing runtime key-policy parsing.
- [x] Registered MCP tools through an identity `z.looseObject({})` carrier whose
      public `.meta()` advertises the compiled document and whose parse returns
      the raw object unchanged; prove both halves with a real SDK round-trip.
- [x] Registered AI tools through `jsonSchema()` with
      raw-value preservation; original validation stays in the shared runner.
- [x] Parsed only extension-key values against `ToolExtend.schema` exactly once
      before `resolve`, preserve filtered-tool behaviour, then strip those keys
      before canonical contract parsing.
- [x] Kept params+input presentation merging, manifests, validation guards,
      prepared-surface caching, native tools and CLI behaviour on one canonical
      presentation path.
- [x] Moved protected native MCP inputs onto the same identity carrier and removed
      their redundant handler-side parse. Raw SDK escape-hatch tools stay raw.
- [x] Removed superseded executable-flatten logic and Zod-internal inspection;
      split the replacement by responsibility if it approaches the repository's
      file-size/modularity threshold.
- [x] Updated public types/exports, guide, API reference, changelog and ADR/index.

## Required regression matrix

- [x] Unique `transform` executes exactly once end-to-end through MCP and agent.
- [x] Normal non-flattened input, params and nested transforms execute exactly
      once through MCP and agent.
- [x] Unique/default/coerce/catch/overwrite/refine/pipe fields cannot mutate raw
      SDK arguments before the original contract parser.
- [x] Existing deep/nested/collision/nullable/enum/base-type flatten promises
      remain useful in the advertised JSON Schema.
- [x] Strict/plain/loose/catchall payloads reach the original parser without
      deletion; strict failures use stitchkit hooks/audit rather than disappearing
      before the callback where the SDK seam permits it.
- [x] `extend` fields are advertised/resolved/stripped exactly once.
- [x] `extend` required/default/coerce/transform/refine behaviour is parsed once
      before `resolve`; failures use Stitchkit's normal result/hooks path.
- [x] `flattenUnionInput: false` behaviour and normal object tools do not regress.
- [x] MCP output validation, multimodal native results and schema portability
      guards remain intact.
- [x] Protected native MCP input transforms execute once; raw native registration
      and multimodal output remain unchanged.
- [x] Packed consumer lane proves the public package surface, not source aliases.

## Acceptance

- [x] The original contract schema is the only parser that can transform data
      delivered to a contract handler.
- [x] No executable flattened Zod schema remains in the contract-tool path.
- [x] No direct dependency on Zod private check internals remains for flattening.
- [x] The confirmed `x → x! → x!!` regression becomes `x → x!` in real MCP and
      agent round-trips.
- [x] All previous flatten guarantees are either preserved or explicitly revised
      with evidence and a breaking migration note.
- [x] `bun run verify` passes: 814 tests, build, Node smoke and all three packed
      consumer lanes were green before the final documentation closeout.

## Plan validator 1 — Zod semantics and soundness

- [x] Expanded the root scope from flattened collisions to every SDK-first
      executable input schema, including params and normal object inputs.
- [x] Added the missing `ToolExtend` parser ownership; identity SDK adapters must
      not silently remove extension validation.
- [x] Included protected native MCP's extra parse in the same correction.
- [x] Split raw-identity and presentation-superset invariants explicitly.
- [x] Constrained flatten to a lossy JSON join with description hints, never
      `if/then`; clarified that arbitrary plain unions may retain union keywords.
- [x] Added strict/plain/loose/catchall, source immutability, `$defs`/references,
      tuple/shared-node and CLI composition coverage to the implementation audit.

## Plan validator 2 — SDK seams and migration risk

- [x] Proved MCP 1.30 end-to-end: `z.looseObject({}).meta(document)` advertises
      the metadata document while the callback receives unknown keys unchanged.
- [x] Confirmed AI SDK 7 `jsonSchema(document, { validate })` supports an identity
      validator, so the shared runner can own real validation.
- [x] Rejected an MCP v2 migration: no package/import/transport churn is needed
      to solve this root problem through current public APIs.
- [x] Required one canonical presentation document for MCP, agent, manifest,
      schema validation and prepared-cache parity.
- [x] Added real MCP/agent callback probes, native/extend regressions and package
      consumer coverage to the acceptance matrix.

## Process — conveyor 2/2

- [x] Task written in `inbox`.
- [x] Two read-only validators review the plan with different lenses.
- [x] Validator findings absorbed; task moved to `in-progress`.
- [x] Implementation completed.
- [x] Full project gate passes.
- [x] Two read-only validators reviewed the implementation with different lenses.
- [x] Findings fixed and targeted gates rerun: 29 tests / 70 expectations green.
- [x] Task completed with `## Что сделано` and moved to `done`.

## Implementation validator 1 — runtime semantics

- [x] Fixed recursive local references when params/input/extend schemas merge;
      the canonical Draft-07 document uses `definitions` consistently and passes AJV.
- [x] Routed throws from extension/params/input effects through
      `beforeToolCall → onToolError → afterToolCall`.
- [x] Restored resolved `ToolExtend` context in both before/after hooks.
- [x] Refused to flatten a discriminator that is optional in any variant.
- [x] Clarified nominal presentation versus runtime `coerce`/`catch` tolerance;
      the identity adapter preserves both without erasing useful schema types.
- [x] Final re-audit: CLEAN.

## Implementation validator 2 — public surface and schema dialect

- [x] Limited nullable widening to projected discriminated-union collisions.
- [x] Preserved discriminator descriptions and corrected nullable literal joins.
- [x] Made the entire model-facing surface Draft-07, including recursive refs,
      empty schemas, tuples and migration snippets.
- [x] Updated the `onToolError` contract and migration documentation to match
      parser/extension failures and the new public flatten API.
- [x] Final re-audit: CLEAN.

## Что сделано

- [x] **Presentation compiler:** `packages/core/src/tools/presentation.ts`,
      `flatten.ts` and `flatten-join.ts` now build one immutable Draft-07 document.
- [x] **Runtime:** `packages/core/src/tools/mount.ts` and `execute.ts` keep original
      contract schemas as the sole executable parsers and parse `ToolExtend` once.
- [x] **MCP / agent / native:** `packages/core/src/tools/mcp.ts`, `agent.ts` and
      `native-mcp.ts` advertise through identity carriers while forwarding raw args.
- [x] **Other surfaces:** CLI, manifests, schema guards, prepared MCP cache and
      packed-consumer fixtures consume the canonical presentation document.
- [x] **Tests:** `packages/core/tests/tool-input-single-parse.test.ts` plus flatten,
      key-policy, native, hook and consumer regressions cover the full split.
- [x] **Docs:** ADR 0050, ADR index, API reference, MCP/observability/upgrading
      guides and CHANGELOG describe the architecture and breaking migration.
- [x] **Not done:** no commit, push, tag, deploy or package publication.
