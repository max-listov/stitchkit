---
title: "Agent application runtime"
description: Configure Stitchkit's optional durable history, stream loop, run coordination and managed-tool fencing.
type: architecture
status: active
created: 2026-08-22
updated: 2026-08-22
---

# Agent application runtime

`stitchkit/agent-runtime` is the server-only, opinionated layer above
`mountAgent`. Use it when the application wants Stitchkit to own conversation
mechanics: durable acceptance, history projection, the AI SDK stream loop,
checkpoints, keyed interruption, terminal commit and stable application events.

If the application already owns that loop, continue importing `mountAgent` from
`stitchkit/tools`. Neither path depends on the other at runtime.

## Install

```sh
bun add stitchkit ai zod
```

OpenRouter is isolated so other runtime users do not resolve its package:

```sh
bun add @openrouter/ai-sdk-provider
```

## Minimal composition

```ts
import { z } from 'zod'
import {
  composeAgentPrompt,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  defineModelRegistry,
} from 'stitchkit/agent-runtime'
import { openRouterProvider } from 'stitchkit/agent-runtime/openrouter'
import { composeToolLifecycle, mountAgent } from 'stitchkit/tools'

const protocol = defineAgentProtocol({
  context: z.object({ userId: z.string() }),
  inputMetadata: z.object({}),
})

const models = defineModelRegistry({
  providers: {
    openrouter: openRouterProvider({ apiKey: env.OPENROUTER_API_KEY }),
  },
  models: {
    fast: {
      provider: 'openrouter',
      modelId: 'provider/model',
      contextWindow: 128_000,
      capabilities: ['tools'],
    },
  },
})

const prompt = composeAgentPrompt([
  {
    name: 'product',
    stability: 'stable',
    render: ({ context }) => `Help user ${context.userId}.`,
  },
])

const runtime = createAgentRuntime({
  protocol,
  store: createMemoryAgentRuntimeStore(),
  models: { resolve: () => models.resolve('fast', ['tools']) },
  prompt: ({ context, signal, model }) =>
    prompt({
      context,
      signal,
      budget: {
        contextWindow: model.descriptor.contextWindow,
        reservedOutput: 8_000,
        toolSchemas: { provenance: 'unavailable' },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { provenance: 'unavailable' },
      },
    }),
  tools: ({ context, toolFenceLifecycle }) =>
    mountAgent(service, {
      context,
      lifecycle: composeToolLifecycle(authLifecycle, toolFenceLifecycle),
    }),
  runs: { inputPolicy: 'interrupt', coalescePending: true },
  loop: {
    idleTimeoutMs: 60_000,
    prepareStep: ({ context, steps }) => ({
      activeTools: steps.some((step) => step.toolCalls.length > 0)
        ? ['lookup']
        : ['lookup', 'discover'],
      instructions: `Current account: ${context.userId}`,
    }),
    stopPolicies: [
      {
        name: 'repeated-tool-error',
        when: ({ steps }) => hasRepeatedToolError(steps),
      },
    ],
  },
})

const ticket = runtime.submit({
  conversationId: 'conversation-id',
  idempotencyKey: 'request-id',
  context: { userId: 'user-id' },
  parts: [{ type: 'text', text: 'Hello' }],
})

await ticket.accepted
const terminal = await ticket.result
```

The in-memory store is a reference adapter and has process-local durability
only. Production applications implement `AgentRuntimeStore` with their own
database transaction and, when needed, distributed lease/fencing token.

## Durable order

`acceptInputAndAssignRun` is one atomic operation. It is followed by ownership
acquisition, revision-checked assistant checkpoints and one terminal CAS. The
process-local coordinator releases its lane only after terminal commit.

```text
input + queued run → running → execution settled → terminal CAS → successor
```

With `runs.coalescePending: true`, an active lane has at most one queued
successor. Every later accepted input is atomically appended to that successor;
its `AgentRun.inputMessageIds` records the whole batch and every input ticket
resolves to the same terminal run. Coalescing never mutates the active run.

`AbortSignal.aborted` is only a cooperation request. A successor does not begin
while the predecessor still owns managed callbacks. A hung predecessor blocks
the lane in the first version.

Use `await runtime.interrupt({ conversationId, runId })` when the interruption
must be durable: it first commits `interrupt_requested`, then aborts the local
coordinator signal. `runtime.stop(key)` is the process-local signal-only escape
hatch.

## Store operations

An adapter implements the aggregate `AgentRuntimeStore`, not separate message
and run CRUD stores:

- `acceptInputAndAssignRun`
- `acquireRun`
- `checkpointRunAssistant`
- `requestRunInterrupt`
- `recoverRun`
- `commitRunTerminal`
- `replaceCompactedRange`
- `loadSnapshot` and `scanRecoverable`

Every mutation carries an expected run revision or snapshot version. Input
assignment additionally carries an idempotency identity. A conflict is a
control outcome; stale data is never silently overwritten.

On startup, `scanRecoverable` returns queued/acquired records. `recoverRun`
may abandon them, or requeue an already acquired run only with explicit
`replaySafe: true` evidence. The framework never guesses that an external
side effect is replayable. After an application reconstructs its typed context,
`runtime.resume({ conversationId, runId, context })` admits that queued record
through the same acquisition CAS and coordinator lane; it never creates a
second input message.

Canonical records currently write `schemaVersion: 1`. A durable adapter owns
read-time migration of older rows: migrate to the current shape at its storage
boundary, validate with the exported schema, and write only the current
version. Core deliberately does not guess an application's database migration
or silently accept an unknown future version.

## Events and reconnect

`publish` receives event classes with different guarantees:

- `assistant-delta` is transient and ordered by
  `(runId, runtimeEpoch, sequence)`;
- `assistant-checkpoint` follows a successful checkpoint CAS;
- `run-state` follows durable queue/acquire/interrupt transitions;
- `tool-status` is transient lifecycle presentation with JSON-safe input on
  start and output on completion; internal tool failures remain generic;
- `terminal` follows the winning terminal CAS.

A named custom stop condition terminalizes with `policy_stop`; its `policyName`
is persisted on the run and included in the terminal event/result. `max-steps`
is the reserved built-in policy name. `loop.prepareStep` is the controlled AI
SDK step boundary for changing active tools, model, instructions or messages.
It cannot replace the managed tool set or bypass its lifecycle fence.

`loop.idleTimeoutMs` is inactivity, not total duration: the deadline resets on
every model stream event. A stalled call aborts with durable reason `timeout`;
user interruption and shutdown remain distinct.

Reconnect loads the durable snapshot. Missing transient deltas do not mean the
canonical result was lost. Exactly-once external delivery requires the
application's transactional outbox or stable-ID deduplication.

## Managed tools

Always compose `toolFenceLifecycle` into `mountAgent`. It checks ownership
before a managed side effect and again before accepting its result. Fence loss
uses an internal control signal: it stops the old loop and is not sent to the
model as a tool error.

The framework cannot undo an already-started non-cooperative external effect.
Pass the stable call/run idempotency identity into business mutations when the
effect must be replay-safe.

## History, provider metadata and files

`projectAgentHistory` converts canonical engine records into provider-valid AI
SDK messages and pairs tool calls/results. Provider-required metadata is kept
in a versioned opaque envelope and omitted from product delivery by default.

`ComposedAgentPrompt.instructions` accepts the AI SDK `Instructions` contract.
Use `adaptInstructions` when a provider needs metadata on the system message:

```ts
prompt({
  context,
  signal,
  adaptInstructions: (content) => ({
    role: 'system',
    content,
    providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
  }),
})
```

Attachments and generated files remain application-owned. The runtime only
stores a reference returned by `persistGeneratedFile`; it never silently puts
base64 blobs into the neutral history store.

To send a stored attachment back to a multimodal model, configure
`history.resolveFile`. It maps the neutral file reference to AI SDK file data
(URL, bytes, provider reference or text). Without a resolver the explicit
`unresolvedFile` policy is `text` by default; choose `omit` or `error` when a
placeholder would be incorrect.

## Compaction

`structuredCompaction` summarizes complete provider-valid turn groups outside
the store lock, then calls `replaceCompactedRange` against the exact snapshot
version. A concurrent input produces `conflict`; the stale summary is not
applied. Summary records use the dedicated `summary` role and project to a
provider system message. The consumer supplies the structured summary schema
and prompt. Pass `previousSummary` for a direct call, or configure
`readPreviousSummary` for runtime-managed compaction, to merge and atomically
replace a leading summary on the next compaction.

## Observability

`createAgentObservability` emits a separate operator-only `AgentRunEvent`. It
reuses the same bounded sink lifecycle as request/tool observability without
sending new event kinds to existing request sinks. Product events omit provider
causes; the operator terminal event may include `internalCause`, so its sink
must use internal retention and redaction policy.

Usage values carry `provider-reported`, `computed`, `estimated` or
`unavailable` provenance. Cost additionally carries an ISO currency code;
OpenRouter-reported cost is normalized as USD. Missing values remain absent,
never zero-filled.

In-memory sink delivery is at-most-once per execution. Stable event IDs allow
consumer dedupe; cross-crash exactly-once requires a durable outbox.
