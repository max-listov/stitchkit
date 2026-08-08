---
title: Runtime tool factory with validated context
description: Define identity-bound runtime tools whose per-call context is Zod-validated and strongly typed inside handlers.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 06:53 +00:00
---

# Runtime tool factory with validated context

## Problem

`createToolkit<TContext>()` checks context wiring at mount boundaries, while a
`defineRuntimeTool` handler still receives the loose framework
`RuntimeContext`. Consumers therefore repeat the same context schema parse in
every pathless tool and repeat stable identity fields such as `serviceName` and
`scope`.

## Decision

Add `createRuntimeToolFactory` as the context-validated, identity-bound authoring
surface. Keep standalone `defineRuntimeTool` for tools that do not share a
context schema or identity. The factory validates context once per invocation,
inside the existing shared runner, and hands only parsed context plus parsed
input to the handler.

## Proposed API

```ts
const agentTools = createRuntimeToolFactory({
  serviceName: 'agentKnowledge',
  scope: 'user',
  context: AgentToolContextSchema,
});

const countRecords = agentTools.define({
  name: 'count_records',
  action: 'countRecords',
  method: 'GET',
  description: 'Count records',
  input: CountRecordsInputSchema,
  output: CountRecordsOutputSchema,
  handler: async ({ userId, tz, input }) => ({ count: 0 }),
});
```

## Plan

1. Define factory config and definition types from Zod input/output inference;
   do not duplicate the existing runtime-tool presenter, transport, annotation
   or UI fields.
2. Bind `serviceName`, optional `scope` and optional identity metadata at factory
   creation; require only `action` and semantic `method` per tool and forbid
   overriding bound identity fields.
3. Wrap the authored handler so the context schema parses the current per-call
   runtime context exactly once and the handler receives its output type merged
   with `input` and `params: undefined`.
4. Route context-parse failures through the existing tool runner so lifecycle,
   `onToolError`, `afterToolCall`, normalization and audit remain canonical.
5. Preserve the same `RuntimeToolDefinition` output so MCP, Agent, manifests,
   invokers and prepared surfaces need no parallel mounting API.
6. Export the factory from `stitchkit/tools`; document its relationship with
   `createToolkit` and standalone `defineRuntimeTool`; update generated docs and
   changelog.

## Acceptance

- [x] Factory handlers receive fully inferred Zod context and input with no
  consumer cast or repeated `Schema.parse(context)`.
- [x] Invalid per-call context fails before the authored handler and produces
  the same normalized failure/hooks/audit sequence as another handler throw.
- [x] Context validation occurs once per invocation, including parallel calls,
  and does not introduce shared mutable context.
- [x] Bound `serviceName`/`scope` cannot be overridden on an individual tool.
- [x] With-output and without-output tools, MCP/Agent presenters and transport
  filters remain fully typed.
- [x] The result works unchanged with `mountAgent`, MCP mounts,
  `buildToolManifest` and `createToolInvoker`.
- [x] Runtime, type-level, hook-order and packed-consumer tests pass.

## Что сделано

- [x] **Tools API:** добавлен `createRuntimeToolFactory`, binding общей identity
  и Zod context при сохранении обычного `RuntimeToolDefinition` —
  `packages/core/src/tools/runtime-tool.ts`.
- [x] **Execution:** context парсится ровно один раз внутри каждого canonical
  tool call; validation failure проходит через существующие error/terminal hooks.
- [x] **Types/tests:** покрыты identity override, inferred context, invalid
  context, параллельная изоляция и manifest compatibility —
  `packages/core/tests/runtime-tool-factory.test.ts`.
- [x] **Architecture/docs:** решение закреплено в
  `docs/decisions/0064-runtime-tool-factories-validate-context-at-execution.md`;
  guide, API reference и changelog синхронизированы.
- [x] **Gates:** declarations/public-type guard, все tests, Node smoke и packed
  consumer lane зелёные в `bun run verify`.
