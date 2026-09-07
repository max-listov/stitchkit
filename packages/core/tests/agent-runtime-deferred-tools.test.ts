import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentContextOverflowError,
  AgentRunSchema,
  createAgentRuntime,
  createDeferredAgentToolSurface,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { placeholderDeferredSearch } from '../src/agent-runtime/deferred-tool-search';
import { ranked } from '../src/agent-runtime/deferred-tool-selection';
import { defineRuntimeTool } from '../src/tools';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const descriptor = {
  provider: 'test',
  modelId: 'deferred-tools',
  contextWindow: 100_000,
  capabilities: [],
};

const protocol = defineAgentProtocol({
  context: z.object({ mode: z.enum(['member', 'broadcast']) }),
  inputMetadata: z.object({}),
});

function runtimeTool(name: string, calls: string[]) {
  return defineRuntimeTool({
    name,
    description: `Perform ${name}`,
    identity: { serviceName: 'catalog', action: name, method: 'POST' },
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    handler: ({ input }) => {
      calls.push(name);
      return input;
    },
  });
}

function names(options: Parameters<MockLanguageModelV4['doStream']>[0]): string[] {
  return options.tools?.map((entry) => entry.name) ?? [];
}

describe('deferred Agent tool surface', () => {
  test('searches a large catalog, activates direct tools and preserves direct lifecycle identity', async () => {
    const calls: string[] = [];
    const lifecycle: string[] = [];
    const catalog = Array.from({ length: 40 }, (_, index) =>
      runtimeTool(`operation_${index}`, calls),
    );
    const always = runtimeTool('ask_user', calls);
    const providerSurfaces: string[][] = [];
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        providerSurfaces.push(names(options));
        step += 1;
        const chunks =
          step === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'search-1',
                  toolName: 'tool_search',
                  input: JSON.stringify({ query: 'operation_37' }),
                },
              ]
            : step === 2
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'direct-1',
                    toolName: 'operation_37',
                    input: JSON.stringify({ value: 'done' }),
                  },
                ]
              : [
                  { type: 'text-start', id: 'answer' },
                  { type: 'text-delta', id: 'answer', delta: 'complete' },
                  { type: 'text-end', id: 'answer' },
                ];
        return {
          stream: simulateReadableStream({
            chunks: [
              ...chunks,
              {
                type: 'finish',
                finishReason: { unified: step < 3 ? 'tool-calls' : 'stop', raw: undefined },
                usage,
              },
            ],
          } as never),
        };
      },
    });
    const deferred = createDeferredAgentToolSurface<{ mode: 'member' | 'broadcast' }>({
      runtimeTools: [...catalog, always],
      alwaysOn: ['ask_user'],
      search: {
        name: 'tool_search',
        maxQueryBytes: 128,
        maxResults: 4,
        maxResultBytes: 2_048,
      },
      activation: {
        maxSelectedTools: 4,
        maxActiveTools: 8,
        maxSchemaBytes: 8_192,
      },
    });
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: (runContext) =>
        deferred.mount(runContext, {
          context: runContext.context,
          lifecycle: {
            beforeHandle: (_context, operation) => {
              if (!operation.toolName) throw new Error('expected Agent tool identity');
              lifecycle.push(operation.toolName);
            },
          },
        }),
      loop: { maxSteps: 4, prepareStep: deferred.prepareStep() },
    });
    const result = await runtime.submit({
      conversationId: 'large-catalog',
      idempotencyKey: 'one',
      context: { mode: 'member' },
      parts: [{ type: 'text', text: 'run operation 37' }],
      metadata: {},
    }).result;

    expect(providerSurfaces[0]).toEqual(['ask_user', 'tool_search']);
    expect(providerSurfaces[1]).toEqual(['operation_37', 'ask_user', 'tool_search']);
    expect(calls).toEqual(['operation_37']);
    expect(lifecycle).toEqual(['tool_search', 'operation_37']);
    expect(result.message.parts).toContainEqual({ type: 'text', text: 'complete' });
    await runtime.close();
  });

  test('repairs a known inactive direct call through SEARCH_REQUIRED but leaves unknown calls failed', async () => {
    const calls: string[] = [];
    const surfaces: string[][] = [];
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        surfaces.push(names(options));
        step += 1;
        const call = step === 1 ? 'operation_known' : 'operation_unknown';
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: `call-${step}`,
                toolName: call,
                input: JSON.stringify({ value: 'not-run' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          } as never),
        };
      },
    });
    const deferred = createDeferredAgentToolSurface({
      runtimeTools: [runtimeTool('operation_known', calls)],
      search: {
        name: 'tool_search',
        maxQueryBytes: 128,
        maxResults: 2,
        maxResultBytes: 2_048,
      },
      activation: { maxSelectedTools: 2, maxActiveTools: 4, maxSchemaBytes: 4_096 },
    });
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
      tools: (context) => deferred.mount(context),
      loop: { maxSteps: 2, prepareStep: deferred.prepareStep() },
    });
    const result = await runtime.submit({
      conversationId: 'inactive-call',
      idempotencyKey: 'one',
      context: { mode: 'member' },
      parts: [{ type: 'text', text: 'call it' }],
      metadata: {},
    }).result;
    const searchResult = result.message.parts.find(
      (part) => part.type === 'tool-result' && part.toolName === 'tool_search',
    );
    expect(searchResult).toMatchObject({
      type: 'tool-result',
      outcome: 'success',
      output: { status: 'SEARCH_REQUIRED', selected: ['operation_known'] },
    });
    expect(calls).toEqual([]);
    expect(surfaces[1]).toContain('operation_known');
    expect(result.message.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        toolName: 'operation_unknown',
        outcome: 'error',
      }),
    );
    await runtime.close();
  });

  test('fails closed on invalid registries and construction-time budgets', () => {
    const tool = runtimeTool('base', []);
    expect(() =>
      createDeferredAgentToolSurface({
        runtimeTools: [tool],
        alwaysOn: ['missing'],
        search: { name: 'tool_search', maxQueryBytes: 10, maxResults: 1, maxResultBytes: 512 },
        activation: { maxSelectedTools: 1, maxActiveTools: 2, maxSchemaBytes: 1_000 },
      }),
    ).toThrow(/unknown or duplicate alwaysOn/);
    expect(() =>
      createDeferredAgentToolSurface({
        runtimeTools: [tool],
        alwaysOn: ['base'],
        search: { name: 'tool_search', maxQueryBytes: 10, maxResults: 1, maxResultBytes: 512 },
        activation: { maxSelectedTools: 1, maxActiveTools: 1, maxSchemaBytes: 1_000 },
      }),
    ).toThrow(/base tools exceed maxActiveTools/);
    expect(AgentContextOverflowError).toBeDefined();
  });

  test('rebuilds replacement selection from durable receipts and isolates runs and surfaces', async () => {
    const memberTools = ['member_one', 'member_two', 'member_three', 'member_pin'].map(
      (name) => runtimeTool(name, []),
    );
    const deferred = createDeferredAgentToolSurface<{ mode: 'member' | 'broadcast' }>({
      surfaces: {
        member: { runtimeTools: memberTools },
        broadcast: { runtimeTools: [runtimeTool('broadcast_one', [])] },
      },
      selectSurface: ({ context }) => context.mode,
      pins: ({ context }) => (context.mode === 'member' ? ['member_pin'] : []),
      search: {
        name: 'tool_search',
        maxQueryBytes: 128,
        maxResults: 4,
        maxResultBytes: 2_048,
      },
      activation: { maxSelectedTools: 4, maxActiveTools: 8, maxSchemaBytes: 8_192 },
    });
    const prepare = deferred.prepareStep(async () => ({
      instructions: 'application instruction',
      activeTools: ['member_one', 'member_two', 'member_three'],
    }));
    const run = AgentRunSchema.parse({
      schemaVersion: 1,
      id: 'run-one',
      conversationId: 'conversation',
      inputMessageIds: ['input'],
      assistantMessageId: 'assistant',
      state: 'running',
      revision: 1,
      ownerId: 'runtime',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    });
    const receipt = (selected: string[], runId = run.id, surfaceKey = 'member') => ({
      schemaVersion: 1 as const,
      kind: 'stitchkit.deferred-tool-selection' as const,
      status: 'SELECTED' as const,
      runId,
      surfaceKey,
      selected,
      matches: [],
      truncated: false,
    });
    const toolMessage = (...values: ReturnType<typeof receipt>[]) => ({
      role: 'tool' as const,
      content: values.map((value, index) => ({
        type: 'tool-result' as const,
        toolCallId: `search-${index}`,
        toolName: 'tool_search',
        output: { type: 'json' as const, value },
      })),
    });
    const prepared = await prepare({
      steps: [],
      stepNumber: 2,
      model: new MockLanguageModelV4({}),
      instructions: undefined,
      initialInstructions: undefined,
      messages: [
        toolMessage(receipt(['member_one']), receipt(['member_two'])),
        toolMessage(receipt(['member_three'])),
        toolMessage(receipt(['missing'])),
      ],
      initialMessages: [],
      responseMessages: [],
      toolsContext: undefined,
      runtimeContext: undefined,
      context: { mode: 'member' },
      run,
      signal: new AbortController().signal,
      toolFenceLifecycle: {},
    } as never);
    expect(prepared).toMatchObject({
      instructions: 'application instruction',
      activeTools: ['tool_search', 'member_pin', 'member_three'],
    });

    const isolated = await prepare({
      steps: [],
      stepNumber: 0,
      model: new MockLanguageModelV4({}),
      instructions: undefined,
      initialInstructions: undefined,
      messages: [toolMessage(receipt(['member_one'], 'another-run'))],
      initialMessages: [],
      responseMessages: [],
      toolsContext: undefined,
      runtimeContext: undefined,
      context: { mode: 'broadcast' },
      run: AgentRunSchema.parse({
        ...run,
        id: 'run-two',
        assistantMessageId: 'assistant-two',
      }),
      signal: new AbortController().signal,
      toolFenceLifecycle: {},
    } as never);
    expect(isolated?.activeTools).toEqual(['tool_search']);
  });

  test('keeps a multimodal runtime presenter on the direct mounted tool', async () => {
    const imageTool = defineRuntimeTool({
      name: 'render_image',
      description: 'Render an image',
      identity: { serviceName: 'media', action: 'render', method: 'POST' },
      input: z.object({}),
      output: z.object({ url: z.url() }),
      handler: () => ({ url: 'https://example.com/image.png' }),
      present: {
        agent: () => ({
          type: 'content',
          value: [
            {
              type: 'file',
              data: { type: 'data', data: 'aGVsbG8=' },
              mediaType: 'image/png',
              filename: 'image.png',
            },
          ],
        }),
      },
    });
    const deferred = createDeferredAgentToolSurface({
      runtimeTools: [imageTool],
      search: {
        name: 'tool_search',
        maxQueryBytes: 128,
        maxResults: 2,
        maxResultBytes: 2_048,
      },
      activation: { maxSelectedTools: 2, maxActiveTools: 4, maxSchemaBytes: 4_096 },
    });
    const run = AgentRunSchema.parse({
      schemaVersion: 1,
      id: 'render-run',
      conversationId: 'render-conversation',
      inputMessageIds: ['render-input'],
      assistantMessageId: 'render-assistant',
      state: 'running',
      revision: 1,
      ownerId: 'runtime',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    });
    const mounted = deferred.mount({
      context: { mode: 'member' },
      run,
      signal: new AbortController().signal,
      toolFenceLifecycle: {},
    });
    const presenter = mounted.render_image?.toModelOutput;
    expect(presenter).toBeDefined();
    expect(
      await presenter?.({
        toolCallId: 'render',
        input: {},
        output: { url: 'https://example.com/image.png' },
      }),
    ).toEqual({
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'data', data: 'aGVsbG8=' },
          mediaType: 'image/png',
          filename: 'image.png',
        },
      ],
    });
  });
});

/**
 * A `NO_MATCH` the model can act on.
 *
 * Observed on a real run against 0.83.2: the catalog held `resource_clock:
 * Current server time and timezone.`, the model asked for
 * `resource_clock time timezone` — the tool's own name plus the words it
 * expected to find — and got `NO_MATCH`, twice, widening the query with
 * synonyms each time. The bare name selected it immediately. The whole query
 * was one substring needle, so adding a true word could only ever subtract.
 */
describe('deferred catalog query semantics', () => {
  const manifest = [
    {
      name: 'resource_clock',
      description: 'Current server time and timezone.',
      inputSchema: {},
    },
    {
      name: 'resource_disk',
      description: 'Free space on the data volume.',
      inputSchema: {},
    },
  ];

  test('a phrase that matches nothing falls back to its words, best match first', () => {
    expect(ranked('resource_clock time timezone', manifest)).toEqual(['resource_clock']);
    // Ranked by how many words an entry carries, not by manifest order.
    expect(ranked('free space timezone', manifest)).toEqual([
      'resource_disk',
      'resource_clock',
    ]);
  });

  test('the phrase pass still wins, so every query that selected before selects the same', () => {
    // `resource` is a prefix of both names: the phrase pass answers, in
    // manifest order, and the word pass never runs.
    expect(ranked('resource', manifest)).toEqual(['resource_clock', 'resource_disk']);
    // An exact name is first even though the other entry says "time" too.
    expect(ranked('resource_clock', manifest)).toEqual(['resource_clock']);
  });

  test('words nobody carries still answer nothing', () => {
    expect(ranked('quantum entanglement harness', manifest)).toEqual([]);
  });

  test('the model is told how the query is read', () => {
    // The contract lives where the model can see it, not only in the matcher:
    // an empty answer with no stated rule is indistinguishable from "no such
    // tool" and from "not allowed".
    const search = placeholderDeferredSearch('tool_search');

    expect(search.description).toContain('one phrase');
    expect(search.description).toContain('individual words');
  });
});
