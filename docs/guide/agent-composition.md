---
title: "Agent composition without a second runtime"
description: "Compose contract tools, authenticated realtime control, React views and exact-run behavioral checks."
type: architecture
status: active
created: 2026-09-30 22:45 +07:00
updated: 2026-09-30 23:03 +07:00
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-09-30 22:45 +07:00
---

# Compose an agent application

Use these pieces when an application wants the existing headless harness and a generic
conversation view. An application with its own AI SDK loop keeps `mountAgent`; a product
with custom message projections can keep its transport and UI. No consumer migration is
required. Model selection, storage, compaction, approvals and recovery stay with their
existing owners.

## Resources and tools

```ts
import {
  createAgentHarnessFileResources,
  createHeadlessAgentHarness,
} from 'stitchkit/agent-runtime/harness';
import { createAgentHarnessTools } from 'stitchkit/agent-runtime/harness-tools';

const resources = createAgentHarnessFileResources({
  roots: [{ id: 'guide', kind: 'instruction', path: instructionRoot }],
  limits: { maxTotalBytes: 256 * 1024 },
});
const harness = createHeadlessAgentHarness({
  protocol, store, models, promptBudget,
  resources,
  tools: createAgentHarnessTools(({ context, run }) => ({
    services: [catalogService],
    context: { ...context, messageId: run.assistantMessageId },
    runtimeTools: resources.runtimeTools,
    lifecycle: authorizeTools,
    hooks: observeTools,
  })),
});
```

The factory composes application authorization then the runtime fence through `mountAgent`.
The optional harness-tools leaf preserves the complete tool types, including MCP presenter
declarations; install the same `ai` and `@modelcontextprotocol/server` peers as for
`stitchkit/tools`. The base harness stays AI-only. Every mount option remains available, including registry, runtime tools, extension,
coercion, output stripping, hooks and durability. Async per-run configuration is supported.
The original tools callback still accepts arbitrary typed AI SDK tools and prepareStep.
The resource reader is explicitly selected: filtered allowlists do not gain tools merely
because a loader exists. Root IDs, kinds, provenance and limits are unchanged.

## Server and browser

```ts
import { bindAgentHarnessRealtime } from 'stitchkit/agent-runtime/realtime';

const binding = bindAgentHarnessRealtime(harness, socket, {
  async authorize({ identity, request, signal }) {
    // socket.data comes from your verified Socket.IO handshake, not a browser context.
    if (!await mayAccessConversation(identity, request, signal)) return null;
    return { context: { userId: identity.userId } };
  },
  onError: reportServerError,
});
```

`socket` is the existing `createSocketIOServer` handle, attached to `createServer` (Bun)
or the Node adapter. The access policy checks every operation, file/reference and metadata
as well as snapshot/event reads. Session handshake authentication alone is insufficient.
Conversation ownership and observer/controller roles are application policy; the canonical
control server additionally enforces its exclusive controller lease.

```ts
import { createSocketIOClient } from 'stitchkit';
import { createAgentController } from 'stitchkit/agent-runtime/browser';
import { useAgent } from 'stitchkit/agent-runtime/react';

const transport = createSocketIOClient({ url: serverUrl, auth: sessionAuth });
const agent = createAgentController({ transport, conversationId, access: 'control' });
transport.connect();

function Conversation() {
  const state = useAgent(agent);
  const conversation = state.view.conversations[conversationId];
  // Render canonical messages/parts, transient progress, approvals and state.error.
  return <Transcript conversation={conversation} status={state.status} error={state.error} />;
}

await agent.request({
  operation: 'submit', idempotencyKey: crypto.randomUUID(),
  parts: [{ type: 'text', text: 'Find available items' }],
});
await agent.request({ operation: 'interrupt', runId });
await agent.request({ operation: 'respond-approval', approvalId, approved: true });
await agent.close(); // leaves transport and harness alive
```

Wait for `ready` before sending. Share a controller among views of the same conversation;
create it at session scope, not during React render. Unmount only unsubscribes the view.
To release the session, await `close`; to stop the application, separately close the
binding, transport and harness through the application's shutdown lifecycle. Closing a
view does not interrupt its remote run. Use explicit `interrupt` for cancellation.

Reconnect reattaches and reads durable state. Mutations are not retried automatically:
if an acknowledgement is lost, retain the original idempotency key. Incoming event
buffers and outgoing requests have finite limits; capacity/overflow/lease failures stay
visible. A server overflow deliberately disconnects the transport; reconnect explicitly.

## Check behavior, not just admission

```ts
import { inspectAgentRun } from 'stitchkit/agent-runtime/testing';

const ticket = harness.submit(input);
const admitted = await ticket.admission;
await ticket.result;
const result = inspectAgentRun(await harness.snapshot(input.conversationId), admitted.runId);
result.calledTool('catalog_search');
result.toolSucceeded('catalog_search');
result.notCalledTool('catalog_delete');
result.completed();
```

`calledTool` proves a call record (including an approved continuation linked through that
run’s exact input messages); `toolSucceeded` also needs a matching successful result.
`completed` requires successful terminal output with no pending approval. Prior runs,
provider/policy stops, failed calls and unfinished runs cannot satisfy those assertions.
The helper does not invoke a model or poll; the existing runtime ticket owns execution.
