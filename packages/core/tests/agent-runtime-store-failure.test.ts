import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeEvent,
  type AgentRuntimeStore,
  AgentRunUnsettledError,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';

const CONVERSATION = 'store-failure';

function answer(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: text },
          { type: 'text-end', id: 't' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  });
}

function runtimeOver(store: AgentRuntimeStore, events: AgentRuntimeEvent[] = []) {
  return createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'mock',
          contextWindow: 1_000,
          capabilities: [],
        },
        model: answer('done'),
      }),
    },
    prompt: () => ({
      instructions: '',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({}),
    publish: async (event: AgentRuntimeEvent) => void events.push(event),
  });
}

function submit(runtime: ReturnType<typeof runtimeOver>, id: string) {
  return runtime.submit({
    conversationId: CONVERSATION,
    idempotencyKey: id,
    context: {},
    parts: [{ type: 'text', text: id }],
    metadata: {},
  });
}

type Method =
  | 'loadRun'
  | 'acquireRun'
  | 'checkpointRunAssistant'
  | 'commitRunTerminal'
  | 'recoverRun';

/** The memory store with calls `nth`..`nth + times - 1` of `method` throwing. */
function failing(method: Method, nth: number, times = 1) {
  const durable = createMemoryAgentRuntimeStore();
  let calls = 0;
  const trip = () => {
    calls += 1;
    if (calls >= nth && calls < nth + times) throw new Error(`${method} failed`);
  };
  const store: AgentRuntimeStore = {
    ...durable,
    loadRun: async (input) => {
      if (method === 'loadRun') trip();
      return durable.loadRun(input);
    },
    acquireRun: async (input) => {
      if (method === 'acquireRun') trip();
      return durable.acquireRun(input);
    },
    checkpointRunAssistant: async (input) => {
      if (method === 'checkpointRunAssistant') trip();
      return durable.checkpointRunAssistant(input);
    },
    commitRunTerminal: async (input) => {
      if (method === 'commitRunTerminal') trip();
      return durable.commitRunTerminal(input);
    },
    recoverRun: async (input) => {
      if (method === 'recoverRun') trip();
      return durable.recoverRun(input);
    },
  };
  return { durable, store };
}

async function activeRuns(store: AgentRuntimeStore): Promise<string[]> {
  const snapshot = await store.loadSnapshot(CONVERSATION);
  return snapshot.runs
    .filter((run) => ['queued', 'running', 'interrupt_requested'].includes(run.state))
    .map((run) => run.state);
}

describe('a store failure outside the turn leaves no active run behind', () => {
  test.each([
    ['the read that opens acquisition', 'loadRun', 1, 'success'],
    ['the ownership write', 'acquireRun', 1, 'success'],
    ['the first assistant draft', 'checkpointRunAssistant', 1, 'runtime_failure'],
    ['the terminal commit', 'commitRunTerminal', 1, 'success'],
    // The control: a checkpoint failure inside the turn ends in a terminal.
    ['a checkpoint inside the turn', 'checkpointRunAssistant', 2, 'runtime_failure'],
  ] as const)('%s', async (_where, method, nth, reason) => {
    const { durable, store } = failing(method, nth);
    const runtime = runtimeOver(store);
    const first = await submit(runtime, 'first').result;
    expect(first.reason).toBe(reason);
    expect(await activeRuns(durable)).toEqual([]);
    const second = await submit(runtime, 'second').result;
    expect(second.reason).toBe('success');
    expect(await activeRuns(durable)).toEqual([]);
  });

  test('a read that keeps failing closes the queued run as abandoned, and says why to the operator', async () => {
    const { durable, store } = failing('acquireRun', 1, 4);
    const events: AgentRuntimeEvent[] = [];
    const first = await submit(runtimeOver(store, events), 'first').result;
    expect(first.reason).toBe('abandoned');
    expect(first.message.status).toBe('failed');
    expect(events.map((event) => event.type)).toContain('terminal');
    expect(await activeRuns(durable)).toEqual([]);
    const second = await submit(runtimeOver(store, events), 'second').result;
    expect(second.reason).toBe('success');
  });

  test('a store that never answers rejects with the run to abandon', async () => {
    const { durable, store } = failing('commitRunTerminal', 1, 4);
    const runtime = runtimeOver(store);
    const refusal = await submit(runtime, 'first').result.catch((error: unknown) => error);
    if (!(refusal instanceof AgentRunUnsettledError)) throw refusal;
    expect(refusal.run.state).toBe('running');
    expect(refusal.cause).toEqual(new Error('commitRunTerminal failed'));
    expect(await activeRuns(durable)).toEqual(['running']);
    const closed = await runtime.abandon({
      conversationId: refusal.run.conversationId,
      runId: refusal.run.id,
      expectedRevision:
        (
          await durable.loadRun({
            conversationId: refusal.run.conversationId,
            runId: refusal.run.id,
          })
        )?.run.revision ?? -1,
      staleOwner: true,
    });
    expect(closed.outcome).toBe('applied');
    expect(await activeRuns(durable)).toEqual([]);
    expect((await submit(runtime, 'second').result).reason).toBe('success');
  });

  test('an acquisition that cannot be closed either rejects with the queued run', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const store: AgentRuntimeStore = {
      ...durable,
      acquireRun: async () => {
        throw new Error('acquireRun failed');
      },
      recoverRun: async () => {
        throw new Error('recoverRun failed');
      },
    };
    const refusal = await submit(runtimeOver(store), 'first').result.catch(
      (error: unknown) => error,
    );
    if (!(refusal instanceof AgentRunUnsettledError)) throw refusal;
    expect(refusal.run.state).toBe('queued');
    expect(await activeRuns(durable)).toEqual(['queued']);
  });

  test('a COMMIT whose reply was lost still delivers the answer once', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let replyLost = false;
    const store: AgentRuntimeStore = {
      ...durable,
      commitRunTerminal: async (input) => {
        const committed = await durable.commitRunTerminal(input);
        if (replyLost) return committed;
        replyLost = true;
        throw new Error('connection reset after COMMIT');
      },
    };
    const events: AgentRuntimeEvent[] = [];
    const result = await submit(runtimeOver(store, events), 'first').result;
    expect(result.reason).toBe('success');
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(1);
  });

  test('a lost reply to the closing write still reports the run as closed', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let acquireFailures = 0;
    let replyLost = false;
    const store: AgentRuntimeStore = {
      ...durable,
      acquireRun: async (input) => {
        acquireFailures += 1;
        if (acquireFailures <= 4) throw new Error('acquireRun failed');
        return durable.acquireRun(input);
      },
      recoverRun: async (input) => {
        const recovered = await durable.recoverRun(input);
        if (replyLost) return recovered;
        replyLost = true;
        throw new Error('connection reset after COMMIT');
      },
    };
    const events: AgentRuntimeEvent[] = [];
    const first = await submit(runtimeOver(store, events), 'first').result;
    expect(first.reason).toBe('abandoned');
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(1);
    expect(await activeRuns(durable)).toEqual([]);
  });

  test('a conflict on a run another lane of this process executes leaves it alone', async () => {
    const store = createMemoryAgentRuntimeStore();
    const gate = Promise.withResolvers<void>();
    const held = answer('done');
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        await gate.promise;
        return held.doStream(options);
      },
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      runs: { key: () => 'one-lane' },
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'mock',
            contextWindow: 1_000,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: '',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
    });
    const ticket = submit(runtime, 'first');
    void ticket.accepted.catch(() => undefined);
    const { runId } = await ticket.admission;
    const resumed = runtime.resume({ conversationId: CONVERSATION, runId, context: {} });
    void resumed.accepted.catch(() => undefined);
    const settled = Promise.allSettled([ticket.result, resumed.result]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await activeRuns(store)).toEqual(['running']);
    gate.resolve();
    const [first, second] = await settled;
    const outcomes = [first, second].map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value.reason : String(outcome.reason),
    );
    expect(outcomes.filter((outcome) => outcome === 'success')).toHaveLength(1);
    expect(outcomes.join()).toContain('store conflict during run acquisition');
  });

  test('an acquisition that applied before its reply was lost still closes the run', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let replyLost = false;
    const store: AgentRuntimeStore = {
      ...durable,
      acquireRun: async (input) => {
        const acquired = await durable.acquireRun(input);
        if (replyLost) return acquired;
        replyLost = true;
        throw new Error('connection reset after COMMIT');
      },
    };
    const first = await submit(runtimeOver(store), 'first').result;
    expect(first.reason).toBe('abandoned');
    expect(await activeRuns(durable)).toEqual([]);
  });

  test('a store failure then a real conflict leaves the queued run queued', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let attempts = 0;
    const store: AgentRuntimeStore = {
      ...durable,
      acquireRun: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('acquireRun failed');
        const { version } = await durable.loadSnapshot(CONVERSATION);
        return { outcome: 'conflict', actualVersion: version };
      },
    };
    const refusal = await submit(runtimeOver(store), 'first').result.catch(
      (error: unknown) => error,
    );
    if (!(refusal instanceof AgentRunUnsettledError)) throw refusal;
    expect(await activeRuns(durable)).toEqual(['queued']);
  });

  test('a lost acquisition during an outage names the runtime that owns the record', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let down = false;
    const store: AgentRuntimeStore = {
      ...durable,
      acquireRun: async (input) => {
        const acquired = await durable.acquireRun(input);
        down = true;
        return acquired.outcome === 'applied'
          ? Promise.reject(new Error('reply lost'))
          : acquired;
      },
      loadRun: async (input) => {
        if (down) throw new Error('store down');
        return durable.loadRun(input);
      },
    };
    const runtime = runtimeOver(store);
    const refusal = await submit(runtime, 'first').result.catch((error: unknown) => error);
    if (!(refusal instanceof AgentRunUnsettledError)) throw refusal;
    down = false;
    expect(refusal.run.state).toBe('queued');
    const current = await durable.loadRun({
      conversationId: refusal.run.conversationId,
      runId: refusal.run.id,
    });
    expect(current?.run.ownerId).toBe(refusal.ownerId);
    const closed = await runtime.abandon({
      conversationId: refusal.run.conversationId,
      runId: refusal.run.id,
      expectedRevision: current?.run.revision ?? -1,
      staleOwner: true,
    });
    expect(closed.outcome).toBe('applied');
  });

  test('a run queued behind another process stays queued, and says so', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const store: AgentRuntimeStore = {
      ...durable,
      acquireRun: async () => {
        const { version } = await durable.loadSnapshot(CONVERSATION);
        return { outcome: 'conflict', actualVersion: version };
      },
    };
    const refusal = await submit(runtimeOver(store), 'first').result.catch(
      (error: unknown) => error,
    );
    if (!(refusal instanceof AgentRunUnsettledError)) throw refusal;
    expect(refusal.run.state).toBe('queued');
    expect(await activeRuns(durable)).toEqual(['queued']);
  });

  test('a run another process owns stays untouched', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const store: AgentRuntimeStore = {
      ...durable,
      acquireRun: async (input) => {
        await durable.acquireRun({ ...input, ownerId: 'other-process' });
        return durable.acquireRun(input);
      },
    };
    const refusal = await submit(runtimeOver(store), 'first').result.catch(
      (error: unknown) => error,
    );
    expect(refusal).not.toBeInstanceOf(AgentRunUnsettledError);
    expect(String(refusal)).toContain('store conflict during run acquisition');
    expect(await activeRuns(durable)).toEqual(['running']);
  });
});
