/**
 * A long tool tells the agent's screen what it is doing.
 *
 * The handler API is `ctx.reportProgress` — the one an MCP host already hears.
 * Under the agent runtime each report is a transient `tool-progress` event of
 * the run, folded by the control view into the running call, and never part of
 * what the model reads — so a call that takes minutes shows its stage instead
 * of a bare `started`.
 */
import { describe, expect, test } from 'bun:test';
import { jsonSchema, simulateReadableStream, type ToolSet, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { McpReportProgress } from '../src/contract/runtime-context';
import {
  type AgentRuntimeEvent,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import {
  AGENT_TOOL_PROGRESS_MESSAGE_MAX,
  type AgentControlView,
  createAgentControlView,
  reduceAgentControlEvent,
} from '../src/entrypoints/agent-runtime/browser';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { mountAgent } from '../src/entrypoints/tools/agent';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function toolRound(toolName: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call' as const, toolCallId: 'call-1', toolName, input: '{}' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function textRound() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: 'done' },
        { type: 'text-end' as const, id: 'answer' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

const generation = defineContract(
  { prefix: 'generation', scope: 'public' },
  {
    wait: {
      method: 'POST',
      path: '/wait',
      desc: 'Wait for a generation to finish',
      output: z.object({ status: z.string() }),
      tool: { name: 'generation_wait' },
    },
  },
);

/** The handler a generation service writes: stages through `ctx.reportProgress`, then the result. */
function generationService(
  stages: readonly string[],
  keep?: (report: McpReportProgress | undefined) => void,
) {
  return implement(generation, {
    wait: async (ctx) => {
      keep?.(ctx.reportProgress);
      for (const [index, message] of stages.entries()) {
        await ctx.reportProgress?.({ message, progress: index + 1, total: stages.length });
      }
      return { status: 'finished' };
    },
  });
}

/** A clock that moves one second per reading, so no report falls inside the rate window. */
function steppingClock(): () => Date {
  let at = Date.UTC(2026, 10, 10);
  return () => {
    at += 1_000;
    return new Date(at);
  };
}

async function run(
  tools: ToolSet,
  options: { now?: () => Date } = {},
): Promise<{ events: AgentRuntimeEvent[]; model: MockLanguageModelV4 }> {
  const model = new MockLanguageModelV4({
    doStream: [toolRound('generation_wait'), textRound()],
  });
  const events: AgentRuntimeEvent[] = [];
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'progress',
          contextWindow: 1_000,
          capabilities: ['tools'],
        },
        model,
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' as const },
      contextDecision: 'unavailable' as const,
    }),
    tools: () => tools,
    publish: (event) => void events.push(event),
    loop: { maxSteps: 2 },
    now: options.now ?? steppingClock(),
  });
  await runtime.submit({
    conversationId: 'progress',
    idempotencyKey: 'one',
    context: {},
    parts: [{ type: 'text', text: 'generate' }],
    metadata: {},
  }).result;
  await runtime.close();
  return { events, model };
}

function progressEvents(events: readonly AgentRuntimeEvent[]) {
  return events.filter((event) => event.type === 'tool-progress');
}

function viewAfter(events: readonly AgentRuntimeEvent[]): AgentControlView {
  return events.reduce(reduceAgentControlEvent, createAgentControlView());
}

describe('tool progress under the agent runtime', () => {
  test('each report is a transient event of the call, and the model reads only the result', async () => {
    const stages = ['waiting: queued', 'waiting: rendering', 'finished: done'];
    const { events, model } = await run(mountAgent([generationService(stages)]));

    expect(progressEvents(events)).toEqual(
      stages.map((message, index) =>
        expect.objectContaining({
          type: 'tool-progress',
          callId: 'call-1',
          toolName: 'generation_wait',
          message,
          progress: index + 1,
          total: 3,
        }),
      ),
    );
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(prompt).toContain('finished');
    for (const stage of stages.slice(0, 2)) expect(prompt).not.toContain(stage);
  });

  test('the control view shows the last report while the call runs and drops it when it settles', async () => {
    const stages = ['waiting: queued', 'waiting: rendering'];
    const { events } = await run(mountAgent([generationService(stages)]));
    const lastProgress = events.findLastIndex((event) => event.type === 'tool-progress');
    const running = viewAfter(events.slice(0, lastProgress + 1)).conversations.progress;
    const runId = events[lastProgress]?.runId ?? '';

    expect(running?.transientByRun[runId]?.tools).toEqual({
      'call-1': {
        toolName: 'generation_wait',
        message: 'waiting: rendering',
        progress: 2,
        total: 2,
      },
    });
    const completedAt = events.findIndex(
      (event) => event.type === 'tool-status' && event.status === 'completed',
    );
    const settled = viewAfter(events.slice(0, completedAt + 1)).conversations.progress;
    expect(settled?.transientByRun[runId]?.tools).toEqual({});
  });

  test('a report after the call settled is dropped', async () => {
    let report: McpReportProgress | undefined;
    const { events } = await run(
      mountAgent([generationService([], (kept) => (report = kept))]),
    );
    expect(report).toBeDefined();
    await report?.({ message: 'late' });
    expect(progressEvents(events)).toEqual([]);
  });

  test('reports inside the rate window are dropped, and a long message is cut to the limit', async () => {
    const at = new Date(Date.UTC(2026, 10, 10));
    const long = 'x'.repeat(AGENT_TOOL_PROGRESS_MESSAGE_MAX + 200);
    const { events } = await run(mountAgent([generationService([long, 'second', 'third'])]), {
      now: () => at,
    });
    const published = progressEvents(events);
    expect(published).toHaveLength(1);
    expect(published[0]?.message).toHaveLength(AGENT_TOOL_PROGRESS_MESSAGE_MAX);
  });

  test('a tool that declares its own context schema keeps its context contract', async () => {
    // The tool accepts no context and refuses any object without its own
    // field — so a runtime object put where the SDK validates it fails the
    // call, and the call has to run exactly as it did before.
    const contextSchema = jsonSchema<{ tenant: string }>(
      { type: 'object', properties: { tenant: { type: 'string' } }, required: ['tenant'] },
      {
        validate: (value) =>
          value === undefined
            ? { success: true, value: { tenant: 'none' } }
            : { success: false, error: new Error('a foreign context reached the tool') },
      },
    );
    const own = tool({
      description: 'Wait with its own context',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object' }),
      contextSchema,
      execute: async () => ({ status: 'finished' }),
    });
    const { events } = await run({ generation_wait: own });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        toolName: 'generation_wait',
        status: 'completed',
      }),
    );
  });
});

describe('the control view keeps each call to itself', () => {
  const head = {
    conversationId: 'c',
    runId: 'r',
    runtimeEpoch: 'e',
    emittedAt: '2026-11-10T06:00:00.000Z',
  };

  test('one call settling leaves another running call and its report in place', () => {
    const events: AgentRuntimeEvent[] = [
      {
        ...head,
        type: 'tool-progress',
        sequence: 1,
        callId: 'a',
        toolName: 'one',
        message: 'a working',
      },
      {
        ...head,
        type: 'tool-progress',
        sequence: 2,
        callId: 'b',
        toolName: 'two',
        message: 'b working',
      },
      {
        ...head,
        type: 'tool-status',
        sequence: 3,
        callId: 'b',
        toolName: 'two',
        status: 'failed',
      },
    ];
    expect(viewAfter(events).conversations.c?.transientByRun.r?.tools).toEqual({
      a: { toolName: 'one', message: 'a working' },
    });
  });

  test('an attempt reset clears the running calls with the text', () => {
    const events: AgentRuntimeEvent[] = [
      {
        ...head,
        type: 'tool-progress',
        sequence: 1,
        callId: 'a',
        toolName: 'one',
        message: 'working',
      },
      { ...head, type: 'attempt-reset', sequence: 2, attempt: 2 },
    ];
    expect(viewAfter(events).conversations.c?.transientByRun.r).toEqual({
      text: '',
      reasoning: '',
      tools: {},
    });
  });
});
