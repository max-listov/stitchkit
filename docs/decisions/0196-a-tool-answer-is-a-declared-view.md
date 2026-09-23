# 0196 — A tool answer is a declared view of the HTTP answer

**Status:** Accepted
**Date:** 2026-09-23

Extends [ADR 0014](0014-tool-http-parity.md) with a third intentional difference,
and is read together with [0037](0037-output-strip-diagnostics.md),
[0050](0050-presentation-schema-is-not-a-parser.md) and
[0054](0054-in-process-tool-invocation.md).

## Context

One contract endpoint serves an admin UI over HTTP and a model over MCP, the
agent mount and the CLI. The two readers want different answers. The UI wants
the full record. The model wants a card: every byte of a tool result enters its
context and stays in its history, and personal fields a task does not need are
better never shown to it. A consuming project measured one list tool at 140 KB
full and 14 KB as a card.

Until now an endpoint had one `output` for every surface, and the difference could
only be expressed at a cost:

- **Two endpoints on one path.** One is `expose: ['HTTP']` and the other a tool.
  The description, the schemas and the handler are duplicated. The same consuming
  project carried seven such pairs.
- **A compact default for everyone.** The UI then asks for the full record
  explicitly, so its data hooks stop being direct references to the typed client
  and become wrappers.
- **A branch on `ctx.source`.** Every handler learns about transports, which
  [ADR 0002](0002-generic-core.md) keeps out of it, and the advertised
  `outputSchema` still describes the full record.
- **An `afterHandle` rewrite.** The result is then validated against a schema it
  no longer matches.

Measured across the consumers of this framework, the transformations are mostly
reshapes, not slices. Tags become strings. A flow node changes type. A card or a
full profile is chosen by what the call asked to include. So a second schema
applied by `parse` is not enough.

## Decision

An endpoint may declare a **tool view**, `tool.view: { defaults?, output?, project? }`,
written with `withToolView(endpoint, view)`. The view is the endpoint's answer on
the tool surface (MCP, AGENT, CLI).

0. **Tool options are one group.** The view ships inside `tool`, beside the
   options that were top-level keys until 0.93: `tool: { name, view, ui,
   annotations, mcp }`. Everything in the group is read by a tool surface and
   never by HTTP, so an endpoint that can never be a tool refuses the whole group
   with one `tool?: never`, and the next tool option is added in one place — each
   of the five used to be restated as `?: never` on eight to nine union members,
   and `mcp` had been forgotten on several of them. `expose` stays outside: it
   chooses transports, HTTP included. Only the authored endpoint is grouped;
   `MethodDef` stays flat, because runtime tools build it too and they are tools,
   not endpoints. The old top-level keys are refused by name at definition time:
   `defineContract` infers its endpoints, inference admits extra properties, and
   an ignored `toolName` would rename a tool without a word. Grouping now costs
   consumers the migration they owe for this release anyway; after the view
   shipped at the top level it would have cost a second one.

1. **`defaults` are merged into the tool call's arguments before the one parse.**
   Keys the caller did not pass get the view's value, and then the endpoint's own
   `input` parses them. The parser stays the contract's, as ADR 0050 requires.
   The handler receives an ordinary `input`, so a model asking for nothing does
   not pay for the full record's loading. The advertised input schema states the
   tool's `default` and stops requiring that key.
2. **The answer is derived, and then checked.** The full result is validated
   against the full `output` as before. Then `project(full, { input, source })`
   runs, or the result is sliced by the view's `output`. The view's result is then
   validated against the view's schema. `project` is pure and synchronous. A
   projection that throws, returns a Promise or breaks its schema is
   `INTERNAL_SERVER_ERROR`, whatever it threw: the handler already succeeded, and
   an error code escaping the projection would describe the call falsely.
3. **What reads the view.** The view's schema is the one the tool surface
   advertises: MCP `outputSchema`, `structuredContent`, the catalog stamp and the
   surface snapshot. It comes from one function, `toolSurfaceOutputSchema`.
4. **Who applies it.** Only runners built for the tool surface apply it: the MCP,
   agent and CLI mounts, and the MCP elicitation resolver, which must see what the
   handler will see. HTTP, OpenAPI, the typed client and the in-process
   `createToolInvoker` keep the full answer, because code, not a model, is calling
   them. The runner is told by a flag, not by `ctx.source`: `source` carries no
   framework behaviour (ADR 0002).
5. **What the declaration refuses.** `defineContract` refuses a view that cannot
   mean anything:
   - a view not declared by `withToolView` (the helper marks what it builds);
   - an endpoint with no tool transport (for the whole `tool` group, not only
     the view);
   - an endpoint without a full `output`;
   - a raw, `rawBody`, multipart, `responseMeta` or streaming endpoint;
   - a view with neither `output` nor `project`;
   - a default for a key the input lacks, for a path param, or with a value the
     input rejects.

   `withToolView` types `project` against the endpoint's own schemas. It refuses
   at compile time a slice whose schema does not accept the full result.

## Alternatives considered

- **A separate input schema for the tool surface** (`toolView.input`). Rejected.
  Its result would be parsed again by the full `input`, which brings back the
  double execution of `.transform()` that ADR 0050 was written to end. It would
  also silently drop keys the full `input` does not declare. Defaults change what
  a call is given, never which keys the endpoint accepts. That is also why
  acceptance parity (ADR 0014, point 1) holds unchanged.
- **Only a second output schema** (a compact `output` applied by `parse`).
  Rejected. It covers slices and none of the reshapes the consumers measured. It
  saves bytes of the answer but not the loading.
- **`project` with the full call context.** Rejected. A field the tool answer
  needs, such as one read asynchronously from a database, belongs in the full
  answer and is loaded by the handler. A projection with access to context and I/O
  would be a second handler.
- **Merging with `present` on runtime tools.** Not done. `present` renders data
  into what the model reads (text and content parts). A view is data with a
  schema. They compose: view, then validation, then `present`.
- **Inline `toolView` typed by `defineContract`.** Measured and not workable:
  TypeScript does not contextually type a lambda's parameters from a sibling
  property inferred in the same object, even through `NoInfer`. The helper infers
  the endpoint first and types the view from it, and it is the one way to declare
  a view: a bare object in `tool.view` would type `project` against nothing and
  let a slice that cannot hold the full answer through. The stored view remains a
  plain runtime shape plus the helper's mark, so it can be checked at declaration.
- **Keeping the tool options at the top level.** Rejected; see point 0. The
  measured price of the group is one mechanical edit per endpoint that names a
  tool, which a codemod performs (`packages/core/scripts/codemod-tool-group.ts`).

## Consequences

- **HTTP is unchanged.** An endpoint with a view answers HTTP byte for byte like
  the same endpoint without one, and its OpenAPI document is identical.
- **The snapshot changes only where a view exists.** A surface-snapshot operation
  row carries `toolView` only where one is declared. It holds digests of the
  defaults and output, and records *whether* a projection runs, since its code has
  no digest. A snapshot of an application without views does not move a byte, so
  `manifestVersion` stays 3.
- **Strip diagnostics.** Keys a projection returns beyond its schema are reported
  by the output-strip diagnostic. A slice removes keys on purpose and is not
  reported, consistent with ADR 0037.
- **`afterToolCall` sees the tool answer.** It records what the caller received,
  not the full record. Its `args` are the caller's; the view's defaults are part
  of the parsed `input` the handler received, not of the arguments sent.
- **`MethodDef` is built by one function.** `implement` and `implementRemote` now
  share one builder, so a proxy carries the view and projects locally. The two
  hand-written copies had drifted: the remote one left a proxied streaming
  endpoint mountable as a tool, which the shared builder ends. The one field the
  proxy still drops is `mcp`, now on purpose — its forwarded call carries only
  `params` and `input`, so elicitation answers given on the proxy could never
  reach the origin.
- **A proxy projects, but may not save the origin's loading.** The proxy parses
  the defaults and projects with them. The forwarded call is ordinary HTTP,
  though, and a GET query has no form for an empty array, so an `include: []`
  default does not reach the origin, which applies its own HTTP default. The
  answer is correct; the origin-side saving needs a default with a query form,
  or a body method.
- **One `desc` serves both surfaces.** A view changes the answer, not the
  description. Where the tool needs its own instructions, `desc` is written for
  the model — it is what a model reads to choose the tool.
