---
title: "Tool hooks take one options object"
description: Convert all three ToolCallHooks callbacks from positional parameters to one shared options object, so future fields are additive and every hook uses one vocabulary.
type: task
status: done
created: 2026-08-06
updated: 2026-08-07
completed: 2026-08-07 06:35 +00:00
related: docs/decisions/0042-the-audit-row-may-name-the-cause.md
---

# Tool hooks take one options object

> **Target release:** 0.37.0. The breaking cleanup is approved for this release:
> all three hooks change together, with no positional compatibility overloads.

## Why it comes up

`afterToolCall` grew to seven positional parameters in 0.32.0:

```ts
(toolName, args, result, durationMs, context, endpoint, error?) => void
```

Each addition was individually correct and additive. The sum is a signature
where the reader counts commas, and where a consumer who wants only the seventh
argument must name six placeholders to reach it — the `_n, _a, _r, _d, _c, _e`
prefix already appears in this repo's own tests.

The three tool hooks now also disagree with each other: `beforeToolCall` takes
four, `onToolError` four, `afterToolCall` seven. Nothing about the domain
explains the difference; it is the order they were written in.

## The shape

One object per hook, same key names across all three so a reader learns them
once:

```ts
// before
afterToolCall: (toolName, args, result, durationMs, context, endpoint, error) => { … }

// after
afterToolCall: ({ toolName, args, result, durationMs, context, endpoint, error }) => { … }
```

Every future field is then additive forever, which is the actual prize: this is
the second time in one day a hook needed one more piece of information, and
there is no reason to expect a third not to come.

## Cost, stated honestly

Breaking for every consumer that writes any tool hook — mechanical, but it is
their code, not ours. In this repo it also touches `createAuditHook`,
`createToolLogger` and their tests.

Per the project's rule, breaking is allowed and must never be silent: a
`### ⚠️ Breaking changes` section leading the version, before → after for each
of the three hooks, a minor bump, no compatibility shim, and consumers this
repo's owner controls updated in the same pass.

If we do it, **all three hooks at once**. Converting only `afterToolCall`
because it is the one that hurts would leave the interface with two styles and
guarantee this note is written a third time.

## Decision

Three consuming projects are mid-migration right now — one of them is sixteen
minors behind. Every break spends goodwill and adds a step to migrations already
queued. The seven parameters are ugly, not broken; nobody has reported being
hurt by them, whereas everything shipped today came from a report.

The cleanup ships in 0.37.0 together with the next framework changes. This is
the point to pay the migration cost once: the same release adds a native-tool
registration path whose hooks must be born with the final callback shape.

## Implementation plan

1. Define named argument types for `beforeToolCall`, `afterToolCall` and
   `onToolError`. Reuse the same field names across all three; each hook receives
   only the fields meaningful at that phase.
2. Change `ToolCallHooks` and the executor call sites to pass one object. Do not
   retain overloads, deprecated aliases or positional adapters.
3. Update framework presets and internal consumers: `createAuditHook`,
   `createToolLogger`, MCP/agent/CLI mounts and every test callback.
4. Add compile-time tests that destructuring exposes the expected fields and
   that a future optional field can be added without changing callback arity.
5. Write an ADR for the one-object hook convention and add it to the decision
   index. Update JSDoc, observability guide, MCP guide and API reference.
6. Lead the 0.37.0 changelog entry with `### ⚠️ Breaking changes`, including
   before → after snippets for all three hooks. Update every owner-controlled
   consumer in the same release pass without naming consumers in this repo.

## Acceptance

- [x] All three hooks converted in one pass, shared key names
- [x] `createAuditHook`, `createToolLogger` and every test updated
- [x] No positional overload, adapter, deprecated alias or compatibility shim remains
- [x] Compile-time coverage pins the destructurable argument shape of every hook
- [x] `### ⚠️ Breaking changes` with before → after for each hook
- [x] `docs/guide/observability.md`, `docs/api/reference.md`, the JSDoc on each
      hook
- [x] The owner-controlled consumer migrations remain a single release step →
      tracked by `docs/backlog/planned/2026-08-07-release-0.37.0-hardening.md`
- [x] ADR — one decision record covering the shape and the "all three at once"
      rule, so a fourth hook is born in the right form

## Что сделано

- [x] **Public API:** `BeforeToolCallOptions`, `AfterToolCallOptions` and
  `ToolErrorOptions` are defined in `packages/core/src/tools/execute.ts` and
  exported from `stitchkit/tools`.
- [x] **Runner:** all three executor invocations pass one object; no positional
  path remains in `packages/core/src/tools/execute.ts`.
- [x] **Presets:** audit and tool logger destructure the canonical options in
  `packages/core/src/observability/audit.ts` and
  `packages/core/src/tools/tool-logger.ts`.
- [x] **Tests and packed consumer:** every internal callback/callsite migrated;
  compile-time named-type coverage lives in `packages/core/tests/execute.test.ts`
  and the external shape is exercised by the full consumer fixture.
- [x] **Architecture and docs:** ADR 0046 plus its index row, observability/MCP
  guides, API reference, generated LLM docs and the 0.37.0 breaking changelog
  show the final object form.
- [x] **Gates:** lint and typecheck passed; 86 focused runner/audit/context tests,
  declaration build/public-type guard and both packed consumer fixtures passed.
