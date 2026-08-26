import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentMessagePartSchema,
  AgentMessageSchema,
  AgentMessageStatusSchema,
  AgentRunSchema,
  type AgentRuntimeEvent,
  type AgentRuntimeStore,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  projectAgentHistoryDetailed,
  selectAgentHistory,
  structuredCompaction,
} from '../src/agent-runtime';
import {
  assistantStatus,
  isSpeakableAssistantStatus,
} from '../src/agent-runtime/terminal-status';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const descriptor = {
  provider: 'test',
  modelId: 'test-model',
  contextWindow: 1_000,
  capabilities: [],
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
});

const PARTIAL = 'Hello! We are the team, where would you like';

/**
 * A first call that streams a fragment and then waits to be aborted, and a
 * second that finishes at once.
 *
 * The halting stream ends by *closing* rather than throwing, which is the abort
 * path that commits an interrupted assistant with **no** `control` part. Any
 * marker conditioned on that part would be missing from exactly the runs a
 * newer input ends — so this is the shape the projection has to survive.
 */
function haltingThenFinishing() {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      calls += 1;
      if (calls > 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-2' },
              { type: 'text-delta', id: 'text-2', delta: 'Cape Town it is.' },
              { type: 'text-end', id: 'text-2' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        };
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: PARTIAL });
            abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
      };
    },
  });
}

function runtimeFor(
  model: MockLanguageModelV4,
  options: {
    inputPolicy: 'queue' | 'interrupt' | 'supersede';
    coalescePending?: boolean;
    publish?(event: AgentRuntimeEvent): void;
  },
) {
  const store = createMemoryAgentRuntimeStore();
  const runtime = createAgentRuntime({
    protocol,
    store,
    models: { resolve: () => ({ descriptor, model }) },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({}),
    runs: {
      inputPolicy: options.inputPolicy,
      ...(options.coalescePending && { coalescePending: true }),
    },
    ...(options.publish && { publish: options.publish }),
  });
  return { store, runtime };
}

function send(
  runtime: ReturnType<typeof createAgentRuntime>,
  idempotencyKey: string,
  text: string,
) {
  return runtime.submit({
    conversationId: 'conversation-1',
    idempotencyKey,
    context: {},
    parts: [{ type: 'text', text }],
    metadata: {},
  });
}

/** Resolves once the first run has actually produced the fragment. */
function fragmentSeen() {
  const seen = Promise.withResolvers<void>();
  return {
    promise: seen.promise,
    publish(event: AgentRuntimeEvent) {
      if (event.type === 'assistant-delta') seen.resolve();
    },
  };
}

describe('a superseding input discards what the run it ended produced', () => {
  test('the next prompt carries both user messages and no abandoned fragment', async () => {
    const model = haltingThenFinishing();
    const gate = fragmentSeen();
    const { store, runtime } = runtimeFor(model, {
      inputPolicy: 'supersede',
      publish: gate.publish,
    });

    const first = send(runtime, 'input-1', 'Hello');
    await first.accepted;
    await gate.promise;
    const second = send(runtime, 'input-2', 'I want to buy a tour to Cape Town');

    const superseded = await first.result;
    expect(superseded.reason).toBe('superseded');
    expect(superseded.run.state).toBe('superseded');
    expect(superseded.message.status).toBe('superseded');

    await second.result;

    // The prompt the provider was handed for the SECOND run is the whole point.
    const prompt = model.doStreamCalls[1]?.prompt ?? [];
    const rendered = JSON.stringify(prompt);
    expect(rendered).not.toContain(PARTIAL);
    expect(rendered).toContain('Hello');
    expect(rendered).toContain('I want to buy a tour to Cape Town');
    expect(prompt.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(prompt.filter((message) => message.role === 'assistant')).toHaveLength(0);

    // Discarded from the prompt, not from the record.
    const snapshot = await store.loadSnapshot('conversation-1');
    const kept = snapshot.messages.find((message) => message.status === 'superseded');
    expect(kept?.parts).toContainEqual({ type: 'text', text: PARTIAL });
    await runtime.close();
  });

  test('an interrupt keeps what a supersede discards, and neither reads a flag', async () => {
    const model = haltingThenFinishing();
    const gate = fragmentSeen();
    const { store, runtime } = runtimeFor(model, {
      inputPolicy: 'interrupt',
      publish: gate.publish,
    });

    const first = send(runtime, 'input-1', 'Hello');
    await first.accepted;
    await gate.promise;
    const second = send(runtime, 'input-2', 'I want to buy a tour to Cape Town');

    const interrupted = await first.result;
    // The same abort under the other policy — read straight off the terminal
    // reason, with no modifier to consult.
    expect(interrupted.reason).toBe('interrupted');
    expect(interrupted.run.state).toBe('interrupted');
    expect(interrupted.message.status).toBe('interrupted');

    await second.result;
    const rendered = JSON.stringify(model.doStreamCalls[1]?.prompt ?? []);
    expect(rendered).toContain(PARTIAL);
    // …and it no longer passes as a finished turn.
    expect(rendered).toContain('[interrupted: this turn was cut off before it finished]');

    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.messages.some((message) => message.status === 'superseded')).toBe(false);
    await runtime.close();
  });

  test('the superseding input lands in the successor, not in the run it ended', async () => {
    const model = haltingThenFinishing();
    const gate = fragmentSeen();
    const { store, runtime } = runtimeFor(model, {
      inputPolicy: 'supersede',
      coalescePending: true,
      publish: gate.publish,
    });

    const first = send(runtime, 'input-1', 'Hello');
    const firstAdmission = await first.admission;
    await gate.promise;
    const second = send(runtime, 'input-2', 'two');
    const third = send(runtime, 'input-3', 'three');
    await Promise.all([second.accepted, third.accepted]);

    const [secondAdmission, thirdAdmission] = await Promise.all([
      second.admission,
      third.admission,
    ]);
    expect(secondAdmission.runId).toBe(thirdAdmission.runId);
    expect(secondAdmission.runId).not.toBe(firstAdmission.runId);

    await Promise.all([first.result, second.result, third.result]);
    const snapshot = await store.loadSnapshot('conversation-1');
    const ended = snapshot.runs.find((run) => run.id === firstAdmission.runId);
    const successor = snapshot.runs.find((run) => run.id === secondAdmission.runId);
    expect(ended?.state).toBe('superseded');
    expect(ended?.inputMessageIds).toHaveLength(1);
    expect(successor?.inputMessageIds).toHaveLength(2);
    await runtime.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const at = '2026-08-25T00:00:00.000Z';

async function appendTurn(
  store: AgentRuntimeStore,
  index: number,
  reason: 'success' | 'superseded',
): Promise<void> {
  const input = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: `input-${index}`,
    conversationId: 'conversation-1',
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: `question ${index}` }],
    createdAt: at,
    updatedAt: at,
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: `run-${index}`,
    conversationId: 'conversation-1',
    inputMessageIds: [input.id],
    assistantMessageId: `assistant-${index}`,
    state: 'queued',
    revision: 0,
    createdAt: at,
    updatedAt: at,
  });
  await store.acceptInputAndAssignRun({ idempotencyKey: `request-${index}`, input, run });
  const acquired = await store.acquireRun({
    conversationId: 'conversation-1',
    runId: run.id,
    expectedRevision: 0,
    ownerId: 'test-runtime',
  });
  if (acquired.outcome !== 'applied') throw new Error('fixture run was not acquired');
  const current = acquired.snapshot.runs.find((candidate) => candidate.id === run.id);
  if (!current) throw new Error('fixture run missing');
  await store.commitRunTerminal({
    conversationId: 'conversation-1',
    runId: run.id,
    expectedRevision: current.revision,
    ownerId: 'test-runtime',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: run.assistantMessageId,
      conversationId: 'conversation-1',
      runId: run.id,
      role: 'assistant',
      status: assistantStatus(reason),
      parts: [{ type: 'text', text: `answer ${index}` }],
      createdAt: at,
      updatedAt: at,
    }),
    reason,
  });
}

describe('a superseded record is not conversation, in every walker that reads history', () => {
  test('compaction neither summarises it nor deletes its record', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendTurn(store, 1, 'superseded');
    await appendTurn(store, 2, 'success');
    await appendTurn(store, 3, 'success');
    let eligible: readonly string[] = [];
    const replaced: string[] = [];
    const compact = structuredCompaction({
      schema: z.object({ summary: z.string() }),
      keepRecentTurns: 1,
      threshold: () => true,
      summarize: (context) => {
        eligible = context.eligibleMessages.map((message) => message.id);
        return { summary: context.eligibleMessages.map((m) => m.id).join(',') };
      },
      createSummaryMessage: ({ conversationId, summary, compactedMessages }) => {
        replaced.push(...compactedMessages.map((message) => message.id));
        return AgentMessageSchema.parse({
          schemaVersion: 1,
          id: 'summary-1',
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: summary.summary }],
          createdAt: at,
          updatedAt: at,
        });
      },
    });
    await compact({ conversationId: 'conversation-1', store, signal: AbortSignal.any([]) });

    // The abandoned answer is not summarisation material…
    expect(eligible).not.toContain('assistant-1');
    // …and the turn it belongs to is not replaced, so the record survives.
    expect(replaced).not.toContain('assistant-1');
    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.messages.some((message) => message.id === 'assistant-1')).toBe(true);
  });

  test('the token budget evicts real turns instead of protecting an abandoned one', async () => {
    const message = (id: string, role: string, status: string) =>
      AgentMessageSchema.parse({
        schemaVersion: 1,
        id,
        conversationId: 'conversation-1',
        role,
        status,
        parts: [{ type: 'text', text: id }],
        createdAt: at,
        updatedAt: at,
      });
    const selected = await selectAgentHistory({
      messages: [
        message('u1', 'user', 'committed'),
        message('a1', 'assistant', 'superseded'),
        message('u2', 'user', 'committed'),
        message('a2', 'assistant', 'completed'),
        message('u3', 'user', 'committed'),
        message('a3', 'assistant', 'completed'),
      ],
      availableTokens: 2,
      keepRecentTurns: 1,
      estimateMessage: () => ({ value: 1, provenance: 'measured' }),
    });
    const reasonOf = (id: string) =>
      selected.decisions.find((decision) => decision.messageId === id)?.reason;
    // It is gone, and it says why — not "protected" for a turn nobody speaks.
    expect(reasonOf('a1')).toBe('unspeakable');
    expect(selected.messages.some((entry) => entry.id === 'a1')).toBe(false);
    // Its tokens are not in the total it never spends. Five spoken records at 1
    // each, minus the oldest evictable turn (u2+a2) — so 3, not 5.
    expect(selected.totalTokens).toEqual({ value: 3, provenance: 'measured' });
    expect(reasonOf('u2')).toBe('oldest-eligible-turn');
    expect(reasonOf('a3')).toBe('protected-recent-turn');
    // u1 stays: the user really said it, and its answer being discarded does
    // not unsay it. What used to be pinned here was the *answer*.
    expect(reasonOf('u1')).toBe('protected-incomplete-turn');
  });

  test('a durable interrupt landing on the terminal commit cannot resurrect the fragment', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let firstTerminal = true;
    const store: AgentRuntimeStore = {
      ...durable,
      async commitRunTerminal(input) {
        if (firstTerminal) {
          firstTerminal = false;
          // A stop button arrives between the executor's last read and its CAS.
          const snapshot = await durable.loadSnapshot(input.conversationId);
          const run = snapshot.runs.find((candidate) => candidate.id === input.runId);
          if (run) {
            await durable.requestRunInterrupt({
              conversationId: input.conversationId,
              runId: input.runId,
              expectedRevision: run.revision,
            });
          }
          return { outcome: 'conflict', actualVersion: snapshot.version };
        }
        return durable.commitRunTerminal(input);
      },
    };
    const model = haltingThenFinishing();
    const gate = fragmentSeen();
    const runtime = createAgentRuntime({
      protocol,
      store,
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      runs: { inputPolicy: 'supersede' },
      publish: gate.publish,
    });
    const first = send(runtime, 'input-1', 'Hello');
    await first.accepted;
    await gate.promise;
    const second = send(runtime, 'input-2', 'Actually, somewhere else');

    const ended = await first.result;
    // The interrupt request says STOP; it does not say "keep what it produced".
    expect(ended.reason).toBe('superseded');
    expect(ended.message.status).toBe('superseded');
    await second.result;
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt ?? [])).not.toContain(PARTIAL);
    await runtime.close();
  });

  test('stop() can take the same decision by hand', async () => {
    const model = haltingThenFinishing();
    const gate = fragmentSeen();
    const { runtime } = runtimeFor(model, { inputPolicy: 'queue', publish: gate.publish });
    const first = send(runtime, 'input-1', 'Hello');
    await first.accepted;
    await gate.promise;
    // No newer input — the application knows the answer reached nobody.
    expect(runtime.stop('conversation-1', 'supersede')).toBe(true);
    const ended = await first.result;
    expect(ended.reason).toBe('superseded');
    expect(ended.message.status).toBe('superseded');
    await runtime.close();
  });

  test('every message status is read the same way by every walker', async () => {
    // The guard that would have caught all three defects above. Two of the
    // walkers used blacklists, so a new status was speakable by default in
    // both; this fails on the next enum member instead of the next release.
    for (const status of AgentMessageStatusSchema.options) {
      const speakable = isSpeakableAssistantStatus(status);
      const assistant = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: 'a1',
        conversationId: 'conversation-1',
        role: 'assistant',
        status,
        parts: [{ type: 'text', text: 'fragment' }],
        createdAt: at,
        updatedAt: at,
      });
      const user = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: 'u1',
        conversationId: 'conversation-1',
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: at,
        updatedAt: at,
      });
      const projected = await projectAgentHistoryDetailed([user, assistant]);
      expect(
        JSON.stringify(projected.messages).includes('fragment'),
        `projection disagrees for status "${status}"`,
      ).toBe(speakable);
      const budget = await selectAgentHistory({
        messages: [user, assistant],
        availableTokens: 100,
        keepRecentTurns: 1,
        estimateMessage: () => ({ value: 1, provenance: 'measured' }),
      });
      const kept = budget.messages.some((entry) => entry.id === 'a1');
      // Every walker now answers with the same predicate, so the budget drops
      // exactly what the projection refuses to send — no status is protected
      // from eviction while being withheld from the model.
      expect(kept, `budget disagrees for status "${status}"`).toBe(speakable);
    }
  });

  test('no part type leaves a projection without a decision naming it', async () => {
    // `assistantMessages` renders four part types by name. A ninth part added
    // to the union would otherwise vanish upstream in silence — the exact way
    // the `control` marker disappeared for a release.
    const types = AgentMessagePartSchema.options.map((option) => option.shape.type.value);
    expect(types.length).toBeGreaterThan(4);
    const sample: Record<string, unknown> = {
      text: { type: 'text', text: 'said' },
      reasoning: { type: 'reasoning', text: 'thought' },
      file: { type: 'file', mediaType: 'image/png', reference: 'internal://k' },
      source: { type: 'source', sourceId: 's1' },
      'tool-call': { type: 'tool-call', callId: 'c1', toolName: 't', input: {} },
      'tool-result': { type: 'tool-result', callId: 'c1', toolName: 't', outcome: 'success' },
      provider: {
        type: 'provider',
        envelope: { schemaVersion: 1, provider: 'p', data: {} },
      },
      control: { type: 'control', reason: 'run-interrupted' },
    };
    const assistant = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'a1',
      conversationId: 'conversation-1',
      role: 'assistant',
      status: 'completed',
      parts: types.map((type) => {
        const part = sample[type];
        if (!part) throw new Error(`no sample for part type "${type}" — add one`);
        return part;
      }),
      createdAt: at,
      updatedAt: at,
    });
    const user = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'u1',
      conversationId: 'conversation-1',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'hello' }],
      createdAt: at,
      updatedAt: at,
    });
    const projected = await projectAgentHistoryDetailed([user, assistant]);
    const decision = projected.decisions.find((entry) => entry.messageId === 'a1');
    const rendered = JSON.stringify(projected.messages);
    for (const type of types) {
      const accounted =
        (decision?.omittedParts ?? []).includes(type) ||
        rendered.includes(`"${type}"`) ||
        // tool-result renders as a `tool` role entry rather than by its own name
        (type === 'tool-result' && rendered.includes('"tool-result"'));
      expect(accounted, `part type "${type}" reached neither the prompt nor a decision`).toBe(
        true,
      );
    }
  });
});
