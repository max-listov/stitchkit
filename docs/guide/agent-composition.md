---
title: "Agent composition without a second runtime"
description: "Compose contract tools, authenticated realtime control, React views and exact-run behavioral checks."
type: architecture
status: active
created: 2026-09-30 22:45 +07:00
updated: 2026-09-30 23:03 +07:00
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
import { composeToolLifecycle } from 'stitchkit/tools';
import { mountAgent } from 'stitchkit/tools/agent';

const resources = createAgentHarnessFileResources({
  roots: [{ id: 'guide', kind: 'instruction', path: instructionRoot }],
  limits: { maxTotalBytes: 256 * 1024 },
});
const harness = createHeadlessAgentHarness({
  protocol, store, models, promptBudget,
  resources,
  tools: ({ context, run, toolFenceLifecycle }) =>
    mountAgent([catalogService], {
      context: { ...context, messageId: run.assistantMessageId },
      runtimeTools: resources.runtimeTools,
      access: { gate: composeToolLifecycle(authorizeTools, toolFenceLifecycle) },
      hooks: observeTools,
    }),
});
```

`tools` is called for each run with its validated context. Mount through `mountAgent` and
compose your authorization with the run's `toolFenceLifecycle` by `composeToolLifecycle`: the
fence rejects a call from a run that no longer owns the conversation, and it must run exactly
once. Every mount option remains available, including registry, runtime tools, extension,
coercion, output stripping, hooks and durability, and the callback may be async. The same callback
still accepts arbitrary typed AI SDK tools and prepareStep. `mountAgent` comes from `stitchkit/tools/agent`, which needs only the `ai` peer the
harness already has; the base harness stays AI-only.
The resource reader is explicitly selected: filtered allowlists do not gain tools merely
because a loader exists. Root IDs, kinds, provenance and limits are unchanged.

## Server and browser

`stitchkit/agent-runtime/realtime` and `stitchkit/agent-runtime/react` are evolving: an
application is building on them, and two independent ones in production would make them
stable (ADR 0198).

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

// When an application withdraws someone's access, tell the binding.
await removeMember(conversationId, userId);
binding.revoke(conversationId, (identity) => identity.userId === userId);
```

`socket` is the existing `createSocketIOServer` handle, attached to `createServer` (Bun)
or the Node adapter. The access policy checks every request, file/reference and metadata, and
the attach that opens a stream. Events then flow under that grant without a call per token;
Without a `revoke()` call a grant lasts until the socket disconnects or the conversation is detached: events keep flowing even if your own permission data changed. That fail-open default is deliberate (one check per request, not one per token), so call `revoke` whenever access is withdrawn. `revoke` ends the grant, the next event is re-authorized (`source: 'delivery'`), and a refusal
or failure detaches the conversation and delivers `access-denied`, which puts the controller in
`error` with code `FORBIDDEN` instead of leaving a frozen view. Session handshake
authentication alone is insufficient.
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

Reconnect reattaches and reads durable state; until the attach answers, the view keeps the
last snapshot and its version (only in-flight run text and run cursors are dropped), so the
screen does not go blank. Mutations are not retried automatically: if an acknowledgement is
lost, retain the original idempotency key. Incoming event
buffers and outgoing requests have finite limits; capacity/overflow/lease failures stay
visible, each with a code from the one `AgentControlErrorCode` vocabulary. A reconnect
rejects the requests of the previous connection at once and attaches again, so they
cannot hold capacity the new attach needs. A server overflow deliberately disconnects the
transport; reconnect explicitly.

### An offline outbox, and resync by cursor

A client that must accept input while offline keeps an outbox of its own and drains it
through the controller. The idempotency key is what makes the drain safe: it is chosen
once, when the user acts, and stored with the entry, so a submit retried after a lost
acknowledgement is the same admission, not a second run. One drain runs at a time while
the controller is ready, and an entry leaves the outbox only after its answer: a refusal
(`outcome: 'error'`) is the application's to keep or drop, and a kept one is sent again
after the next attach; a dropped connection leaves the entry first.

```ts
import type { AgentBrowserCommand, AgentController } from 'stitchkit/agent-runtime/browser';

type Submit = Extract<AgentBrowserCommand, { operation: 'submit' }>;
type Pending = Omit<Submit, 'operation'>;

/** Drain `entries` (persist them; the key is chosen once, when the user acts). */
function createOutbox(
  agent: AgentController,
  entries: Pending[],
  onRefused: (entry: Pending, error: { code: string; message: string }) => 'keep' | 'drop',
) {
  let draining = false;
  async function drain() {
    if (draining) return; // one drain at a time: an entry is sent by one loop only
    draining = true;
    try {
      while (agent.getSnapshot().status === 'ready') {
        const next = entries[0];
        if (!next) return;
        const response = await agent.request({ operation: 'submit', ...next });
        if (response.outcome === 'error' && onRefused(next, response.error) === 'keep') return;
        entries.shift(); // admitted (or dropped by the application), never before the answer
      }
    } catch {
      // The connection dropped mid-request: the entry stays first, with its key.
    } finally {
      draining = false;
    }
  }
  const off = agent.subscribe(() => {
    if (agent.getSnapshot().status === 'ready') void drain();
  });
  return {
    push(entry: Pending) {
      entries.push(entry);
      void drain();
    },
    close: off,
  };
}
```

The view resyncs itself. The cursor (`state.view.cursor`) records, per conversation, the
snapshot version the view was built from and the durable events applied since: a repeated
event is dropped, and a durable event whose snapshot version does not follow the view's
marks the conversation `resyncRequired`, after which the controller fetches a fresh
snapshot. Persist the outbox entries, never the transient view: on restart the attach reads
durable state, and the outbox drains into it.

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
