import { describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import {
  AgentContextOverflowError,
  AgentRunSchema,
  createDeferredAgentToolSurface,
} from '../src/agent-runtime';
import { defineRuntimeTool } from '../src/tools';

function definition(name: string, description = name) {
  return defineRuntimeTool({
    name,
    description,
    identity: { serviceName: 'bounded', action: name, method: 'POST' },
    input: z.object({ value: z.string() }),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
}

const run = AgentRunSchema.parse({
  schemaVersion: 1,
  id: 'bounded-run',
  conversationId: 'bounded-conversation',
  inputMessageIds: ['bounded-input'],
  assistantMessageId: 'bounded-assistant',
  state: 'running',
  revision: 1,
  ownerId: 'bounded-runtime',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
});

const runContext = {
  context: {},
  run,
  signal: new AbortController().signal,
  toolFenceLifecycle: {},
};

function searchExecutor(tools: ToolSet) {
  const execute = tools.tool_search?.execute;
  if (!execute) throw new Error('expected deferred search tool');
  return execute;
}

describe('deferred Agent tool ceilings', () => {
  test('bounds custom selection, results and evidence without retaining query content', async () => {
    const events: unknown[] = [];
    let selectorCalls = 0;
    const deferred = createDeferredAgentToolSurface({
      runtimeTools: [definition('target', 'x'.repeat(2_000)), definition('second')],
      search: {
        name: 'tool_search',
        maxQueryBytes: 16,
        maxResults: 2,
        maxResultBytes: 512,
        select: () => {
          selectorCalls += 1;
          return ['target', 'missing', 'target'];
        },
      },
      activation: { maxSelectedTools: 2, maxActiveTools: 4, maxSchemaBytes: 4_096 },
      observe: (event) => events.push(event),
    });
    const search = searchExecutor(deferred.mount(runContext));
    const selected = await search(
      { query: 'private-query' },
      { toolCallId: 'one', messages: [], context: undefined },
    );
    expect(selected).toMatchObject({
      status: 'SELECTED',
      selected: ['target'],
      matches: [],
      truncated: true,
    });
    expect(new TextEncoder().encode(JSON.stringify(selected)).byteLength).toBeLessThanOrEqual(
      512,
    );
    expect(events).toContainEqual(expect.objectContaining({ rejectedNames: 2 }));
    expect(JSON.stringify(events)).not.toContain('private-query');

    const refused = await search(
      { query: 'query-that-is-over-the-configured-byte-limit' },
      { toolCallId: 'two', messages: [], context: undefined },
    );
    expect(refused).toMatchObject({ status: 'SELECTION_REFUSED', selected: [] });
    expect(selectorCalls).toBe(1);
  });

  test('refuses selected tools and dynamic pins before they exceed the shared active ceiling', async () => {
    const tool = definition('target');
    const searchOnly = createDeferredAgentToolSurface({
      runtimeTools: [tool],
      search: { name: 'tool_search', maxQueryBytes: 32, maxResults: 1, maxResultBytes: 512 },
      activation: { maxSelectedTools: 1, maxActiveTools: 1, maxSchemaBytes: 4_096 },
    });
    const receipt = await searchExecutor(searchOnly.mount(runContext))(
      { query: 'target' },
      { toolCallId: 'search', messages: [], context: undefined },
    );
    expect(receipt).toMatchObject({ status: 'SELECTION_REFUSED', selected: [] });

    const pinned = createDeferredAgentToolSurface({
      runtimeTools: [tool],
      pins: () => ['target'],
      search: { name: 'tool_search', maxQueryBytes: 32, maxResults: 1, maxResultBytes: 512 },
      activation: { maxSelectedTools: 1, maxActiveTools: 1, maxSchemaBytes: 4_096 },
    });
    expect(
      pinned.prepareStep()({
        ...runContext,
        messages: [],
        responseMessages: [],
      } as never),
    ).rejects.toBeInstanceOf(AgentContextOverflowError);
  });
});
