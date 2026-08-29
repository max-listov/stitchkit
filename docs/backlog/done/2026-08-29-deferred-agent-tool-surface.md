---
title: Deferred agent tool surface
description: Keep large identity-specific Agent catalogs out of provider context while bounded durable selection activates direct typed tools for one run.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
---

# Deferred agent tool surface

## Problem

`buildToolManifest` exposes the exact framework-owned projection of a mixed
`{ services, runtimeTools }` surface, and the Agent runtime forwards AI SDK
`prepareStep.activeTools`. An application with a large catalog still has to
connect those primitives itself:

1. mount a bounded catalog-search tool;
2. search the canonical manifest without executing an operation;
3. validate every selected name against the mounted Agent surface;
4. expose only the selected direct tools on later provider steps in the same run;
5. reconstruct that activation after recovery without process-local state; and
6. preserve the lifecycle, hooks, presenters, errors and stable operation
   identity supplied by `mountAgent`.

Sending every schema on every step wastes provider context. Replacing the
surface with a generic `{ name, arguments }` gateway fixes that cost by losing
the typed operation identity and the guarantees attached to the real tool.

## Decision

Add one provider-neutral controller to `stitchkit/agent-runtime`. The controller
composes the existing stable `mountAgent` path; it does not add another
collector, mount, executor or MCP client.

The controller owns either one immutable Agent surface or a finite registry of
identity-specific surfaces, all resolved and validated when the application is
constructed:

```ts
const deferred = createDeferredAgentToolSurface({
  surfaces: {
    member: {
      services: memberServices,
      runtimeTools,
      alwaysOn: ['ask_user'],
    },
    broadcast: {
      services: broadcastServices,
      runtimeTools,
      alwaysOn: ['broadcast_list'],
    },
  },
  selectSurface: ({ context }) => context.mode,
  pins: ({ context, steps }) => selectSkillTools(context, steps),
  search: {
    name: 'tool_search',
    maxQueryBytes: 1_024,
    maxResults: 8,
    maxResultBytes: 8_192,
    select: async ({ query, manifest }) => searchCatalog(query, manifest),
  },
  activation: {
    maxSelectedTools: 8,
    maxActiveTools: 16,
    maxSchemaBytes: 32_768,
  },
  observe: event => deferredToolMetrics.record(event),
})

const runtime = createAgentRuntime({
  // ...protocol, store, model and prompt...
  tools: runContext => deferred.mount(runContext, {
    context: runContext.context,
    lifecycle: composeToolLifecycle(authLifecycle, runContext.toolFenceLifecycle),
    hooks,
  }),
  loop: {
    prepareStep: deferred.prepareStep(applicationPrepareStep),
  },
})
```

The exact option names remain subject to implementation-level type review, but
the ownership and composition boundary above are fixed by this task:

- one object-shaped `{ services, runtimeTools, alwaysOn }` surface remains the shorthand
  for applications that do not need a finite registry;
- every finite surface is a canonical executable catalog, and `selectSurface`
  chooses exactly one validated key for the run before search or mounting;
- `mount` delegates every real operation to `mountAgent`;
- `prepareStep` may compose an existing application callback but owns the final
  `activeTools` value so an application callback cannot bypass the ceilings;
- `pins` lets application policy request exact tools for the current step (for
  example, tools belonging to a detected skill); the controller validates and
  budgets those names instead of giving the consumer a second unlock path;
- an optional async selector may use a remote index, but every returned name is
  revalidated against the canonical local manifest before activation; and
- remotely executed handlers are allowed, while remote tool discovery and MCP
  protocol ownership remain outside this primitive.

## State model

| State | Provider-visible tools | Transition |
| --- | --- | --- |
| catalog | search tool, validated `alwaysOn` and current bounded pins | initial step, or no valid same-run selection receipt |
| selected | catalog tools plus the bounded exact names in the latest valid receipt | a successful search in the current run replaces the prior selected set |
| selected | the same selected set, recomputed pins and fixed base tools | later steps and recovery attempts of that same durable run |
| catalog | only the new run's base tools and pins | run terminal, queued successor or a different selected surface key |

Search results carry a versioned framework-owned receipt containing `runId`, the
selected surface key and the selected exact names. The receipt is stored as the
ordinary durable `tool-result` already recorded by the Agent runtime.
`prepareStep` derives the latest same-run selection from durable/model messages
and current-step results; no mutable set, cache or checkpoint exists beside the
Agent store. A successful later search replaces the earlier search-selected
set, so a multi-step workflow can change phases without accumulating every tool
seen during the conversation.

Parallel search calls in one provider step are merged in call order,
deduplicated and admitted as one replacement set. A receipt belonging to
another run or surface is ignored. A receipt with malformed, missing or
no-longer-mounted names is rejected atomically rather than partially widening
the active set. Recovery reconstructs the selected set for the same run;
interruption and queued successors begin from their own catalog state.

`alwaysOn`, current pins and search selections have separate provenance but one
combined ceiling. Pins are recalculated at every step from durable run inputs
and step evidence; they never mutate the durable search receipt.

## Search and budget rules

- The search tool reads `buildToolManifest({ transport: 'AGENT', ...surface })`.
  It never invokes a selected operation.
- The built-in selector ranks normalized exact name, name token/prefix and
  description matches with canonical manifest order as the stable tie-breaker.
- A custom async selector returns names only. Unknown and duplicate names do not
  enter activation; configured limits are enforced after the callback returns.
- Search output contains bounded names and descriptions, never full input
  schemas. The selected real schemas appear only in the following provider
  request through `activeTools`.
- `maxQueryBytes`, `maxResults`, `maxResultBytes`, `maxSelectedTools`,
  `maxActiveTools` and `maxSchemaBytes` are required positive ceilings. Schema
  bytes are UTF-8 bytes over the canonical Stitchkit name, description and
  presentation-schema projection. Provider adapters may serialize that
  projection differently, so actual tokens and cost come only from measured or
  provider-reported runtime usage.
- The search tool plus `alwaysOn` set must fit the active-tool and schema
  ceilings at construction for every finite surface. Pins and a selected set
  are admitted only when the complete next-step set fits; an oversized pin set
  refuses the provider step, while an oversized search selection returns a
  bounded result explaining that the previous valid selection remains in force.
- Tool names, transport exposure, presentation schemas and collisions come only
  from the canonical surface collector used by `mountAgent`.
- Provider-specific schema restrictions remain the provider adapter's boundary.
  The controller guarantees canonical Stitchkit schemas and bounded selection,
  not validity under rules the selected provider does not expose beforehand.

## Inactive and unknown calls

A provider may still emit a tool name that was mentioned by the user or model
history but is absent from the current `activeTools`. When the name exists in
the selected canonical surface but is merely inactive, the Agent runtime records
a typed recoverable `SEARCH_REQUIRED` tool result and returns to the catalog
path. It does not execute or silently activate the operation, and it does not
surface an internal `NoSuchTool` failure to the user.

A name absent from the selected canonical surface remains an ordinary unknown
tool failure. This primitive does not infer intent, reveal another identity's
surface or decide whether an absent capability is unauthorized, temporarily
unavailable or nonexistent.

## Operational evidence

The controller emits structured, PII-free evidence at every prepared step:

- surface key and run-scoped activation source;
- total catalog, base, pinned, selected and active tool counts;
- canonical active-schema bytes and configured ceilings;
- search match, rejected-name and replacement counts; and
- whether the selection came from a current result or durable recovery.

Raw search text, prompts, tool arguments and domain context are never included.
Provider usage stays on the existing Agent usage surface. The guide compares
canonical schema evidence with actual provider input/cost before recommending
adoption: a small catalog may be faster and cheaper without an extra search
round.

## Direct identity guarantee

The model never calls a gateway. After search selects `orders_create`, the next
provider request advertises the actual `orders_create` AI SDK tool produced by
`mountAgent`. Its execution therefore keeps the original contract/runtime
identity, Zod parsing, context, lifecycle, tool fence, hooks, output validation,
error envelope and optional multimodal `present.agent` result.

`mountMcp` remains the direct MCP server transport for the same definitions. A
model calling an external MCP server, hosted MCP configuration and dynamic MCP
discovery are separate concerns and are not routed through this controller.

## Plan

- [x] Record the deferred activation boundary and run-scoped replacement model
  in an ADR, and add it to the decision index.
- [x] Define Zod-first search input, durable receipt and bounded result schemas
  in the Agent runtime entrypoint.
- [x] Implement the immutable single-surface/finite-registry controller over
  `buildToolManifest`, `mountAgent` and `prepareStep.activeTools`; do not expose
  internal mountables.
- [x] Implement deterministic built-in search plus an optional async name
  selector whose output is validated, deduplicated and bounded.
- [x] Enforce query, result, active-tool and exact serialized-schema byte
  ceilings before a provider request is made.
- [x] Derive the latest replacement selection from same-run durable tool
  results across ordinary execution, interruption, queued successors and
  recovery.
- [x] Add validated dynamic pins that share the final active-tool/schema budget
  without creating mutable consumer-owned unlock state.
- [x] Compose an application `prepareStep` without allowing its `activeTools`
  result to widen the controller-owned set.
- [x] Convert a direct call to a known-but-inactive tool into the recoverable
  `SEARCH_REQUIRED` path while retaining an honest failure for unknown names.
- [x] Emit bounded PII-free controller evidence and document comparison with
  provider-reported input usage/cost.
- [x] Preserve direct `mountAgent` execution for contract and runtime tools,
  including lifecycle, observability, fencing, errors and multimodal presenters.
- [x] Export the controller and inferred public types from
  `stitchkit/agent-runtime`; keep `stitchkit/tools` and MCP APIs unchanged.
- [x] Update the Agent runtime guide, MCP/Agent guide, API reference, changelog
  and generated agent-facing documentation.
- [x] Add packed Bun and Node consumer fixtures using only the published package
  surface.

## Acceptance

- [x] A large mixed catalog is fully mounted in process while the initial model
  request receives only the search tool, `alwaysOn` tools and current pins.
- [x] Search returns bounded canonical matches and executes no selected handler.
- [x] Later requests in the same run advertise the latest selected set under
  real names and exact canonical schemas; invoking one traverses the ordinary
  `mountAgent` runner without another search for each direct call.
- [x] A multimodal runtime-tool result keeps its `present.agent` model output
  after deferred activation.
- [x] Lifecycle, fence and observability evidence names the selected operation,
  not the search tool or a generic gateway.
- [x] Query/result/schema/tool ceilings fail before an oversized provider
  request, including output from a custom async selector.
- [x] Every finite surface and its base tools fail first on invalid keys,
  duplicate names or construction-time budget overflow.
- [x] Unknown, malformed, stale, cross-surface and cross-run receipt names fail
  atomically without partially changing the previous valid selection.
- [x] Recovery after a durable search result reconstructs the selected set for
  the same run, while interruption and queued successor runs cannot inherit it.
- [x] A later successful search replaces the prior selected set; current pins
  are recalculated and cannot bypass the shared ceiling.
- [x] A known inactive direct call yields `SEARCH_REQUIRED` without executing
  the handler or exposing an internal error; a truly unknown name stays failed.
- [x] Application `prepareStep` instructions/messages/model overrides compose,
  but cannot widen `activeTools` past the controller decision.
- [x] Bun and Node packed fixtures prove large-catalog search, direct execution,
  recovery isolation and multimodal presentation from the built package.
- [x] Existing `mountAgent`, `mountMcp`, raw `activeTools` and small-catalog
  consumers keep their current behavior.
- [x] Structured evidence reports activation counts/bytes/provenance without
  search text, arguments, prompts or domain context.
- [x] `bun run verify` is green.

## Что сделано

- Добавлен `createDeferredAgentToolSurface`: immutable single surface или заранее
  валидируемый finite registry, canonical manifest/search, direct `mountAgent`
  execution, dynamic pins и общий tool/schema budget.
- Selection хранится только в versioned durable search receipts. Recovery
  восстанавливает latest same-run replacement; stale, malformed, cross-run и
  cross-surface receipts не расширяют активную поверхность.
- Known inactive direct calls переводятся в bounded `SEARCH_REQUIRED` round;
  unknown calls сохраняют штатную ошибку. Lifecycle, fencing, presenters и
  operation identity принадлежат реальному выбранному tool.
- Обновлены ADR 0129, Agent/MCP guides, API reference, changelog и public-surface
  inventory. Packed consumer fixture исполняется из собранного package на Bun и
  Node и доказывает search, direct execution, recovery isolation и multimodal
  presentation.

## Регрессия

- `packages/core/tests/agent-runtime-deferred-tools.test.ts`:
  `searches a large catalog, activates direct tools and preserves direct lifecycle identity`;
  `repairs a known inactive direct call through SEARCH_REQUIRED but leaves unknown calls failed`;
  `fails closed on invalid registries and construction-time budgets`;
  `rebuilds replacement selection from durable receipts and isolates runs and surfaces`;
  `keeps a multimodal runtime presenter on the direct mounted tool`.
- `packages/core/tests/agent-runtime-deferred-budgets.test.ts`:
  `bounds custom selection, results and evidence without retaining query content`;
  `refuses selected tools and dynamic pins before they exceed the shared active ceiling`.
- `packages/core/scripts/consumer-lane/fixtures/node/src/deferred-tools.mjs` runs
  through the packed consumer lane on Bun and Node.
- `bun run verify` passed on the completed implementation tree.

## Non-goals

- A generic `{ server, name, arguments }` execution gateway.
- External MCP discovery, MCP client ownership or provider-hosted MCP config.
- Lazy loading of definitions that are absent from the canonical local surface.
- Arbitrary per-run catalog factories that bypass an eagerly validated finite
  surface registry.
- A second schema walker, surface collector or mount path.
- Framework-owned embeddings, vector storage or domain search ranking.
- Persisting activation outside ordinary Agent runtime messages/checkpoints.
- Claiming exact provider token usage from serialized byte counts.
- Framework-owned capability intent classification or authorization policy;
  identity-specific surface selection and tool lifecycle remain the boundaries.
- Automatically enabling deferred search for small catalogs without measured
  provider-context evidence.
