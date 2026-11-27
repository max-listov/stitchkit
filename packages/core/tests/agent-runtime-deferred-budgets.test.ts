import { describe, expect, test } from 'bun:test';
import { asSchema, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  AgentContextOverflowError,
  AgentRunSchema,
  createDeferredAgentToolSurface,
} from '../src/entrypoints/agent-runtime';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import { createImplement } from '../src/entrypoints/server';
import { defineRuntimeTool } from '../src/entrypoints/tools';

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
  toolFenceLifecycle: { beforeHandle: () => undefined },
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
    const search = searchExecutor(
      deferred.mount(runContext, { access: { open: 'local-operator' } }),
    );
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
    const receipt = await searchExecutor(
      searchOnly.mount(runContext, { access: { open: 'local-operator' } }),
    )({ query: 'target' }, { toolCallId: 'search', messages: [], context: undefined });
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

  test('the nesting limit shapes the schemas the deferred surface mounts', async () => {
    let inner: z.ZodType = z.string();
    for (const name of ['f9', 'f8', 'f7', 'f6', 'f5', 'f4', 'f3', 'f2', 'f1'])
      inner = z.object({ [name]: inner });
    const lessonInput = z.object({ items: inner });
    const lesson = defineRuntimeTool({
      name: 'lesson_put',
      description: 'put a lesson',
      identity: { serviceName: 'bounded', action: 'lesson_put', method: 'POST' },
      input: lessonInput,
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const mounted = async (inputNestingDepth?: number) => {
      const deferred = createDeferredAgentToolSurface({
        runtimeTools: [lesson],
        alwaysOn: ['lesson_put'],
        ...(inputNestingDepth !== undefined && { inputNestingDepth }),
        search: { name: 'tool_search', maxQueryBytes: 64, maxResults: 1, maxResultBytes: 512 },
        activation: { maxSelectedTools: 1, maxActiveTools: 2, maxSchemaBytes: 100_000 },
      });
      const tool = deferred.mount(runContext, {
        access: { open: 'local-operator' },
      }).lesson_put;
      if (!tool) throw new Error('expected the lesson_put tool');
      return JSON.stringify(await asSchema(tool.inputSchema).jsonSchema);
    };
    const limited = await mounted(10);
    // The node at f8 opens: its step to f9 would be the eleventh level.
    expect(limited).not.toContain('"f9"');
    expect(await mounted()).toContain('"f9"');
  });

  test('the schema-byte ceiling measures every schema as the mount advertises it', async () => {
    interface Expression {
      field?: string;
      fn?: 'add' | 'sub';
      args?: Expression[];
    }
    const Expression: z.ZodType<Expression> = z.lazy(() =>
      z.union([
        z.object({ field: z.string().min(1) }),
        z.object({ fn: z.enum(['add', 'sub']), args: z.array(Expression).min(1) }),
      ]),
    );
    const compute = defineRuntimeTool({
      name: 'compute',
      description: 'compute',
      identity: { serviceName: 'bounded', action: 'compute', method: 'POST' },
      input: z.object({ a: Expression, b: Expression, c: Expression }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const events: { activeSchemaBytes: number }[] = [];
    const surface = (maxSchemaBytes: number) =>
      createDeferredAgentToolSurface({
        runtimeTools: [compute],
        alwaysOn: ['compute'],
        inputRecursionDepth: 6,
        search: { name: 'tool_search', maxQueryBytes: 64, maxResults: 1, maxResultBytes: 512 },
        activation: { maxSelectedTools: 1, maxActiveTools: 2, maxSchemaBytes },
        observe: (event) => events.push(event),
      });
    const deferred = surface(100_000);
    const tools = deferred.mount(runContext, { access: { open: 'local-operator' } });
    const mountedTool = tools.compute;
    if (!mountedTool) throw new Error('expected the compute tool');
    const mounted = JSON.stringify(await asSchema(mountedTool.inputSchema).jsonSchema);
    expect(mounted).not.toContain('$ref');
    const mountedBytes = new TextEncoder().encode(mounted).byteLength;
    await deferred.prepareStep()({
      ...runContext,
      messages: [],
      responseMessages: [],
    } as never);
    expect(events.at(-1)?.activeSchemaBytes).toBeGreaterThan(mountedBytes);
    expect(() => surface(mountedBytes)).toThrow('base tools exceed maxSchemaBytes');
  });

  test('a mount refuses the projection options the surface owns', () => {
    const deferred = createDeferredAgentToolSurface({
      runtimeTools: [definition('target')],
      search: { name: 'tool_search', maxQueryBytes: 32, maxResults: 1, maxResultBytes: 512 },
      activation: { maxSelectedTools: 1, maxActiveTools: 2, maxSchemaBytes: 4_096 },
    });
    for (const option of ['extend', 'flattenUnionInput', 'inputRecursionDepth']) {
      // An untyped caller: the option moved to `createDeferredAgentToolSurface`.
      const mountConfig = JSON.parse(
        `{ "access": { "open": "local-operator" }, "${option}": 2 }`,
      );
      expect(() => deferred.mount(runContext, mountConfig)).toThrow(
        `${option} belongs to createDeferredAgentToolSurface`,
      );
    }
  });

  test("the surface's extend and flattenUnionInput shape the manifest the selector ranks and the tools it mounts", async () => {
    const contract = defineContract(
      { prefix: 'projected', scope: 'public' },
      {
        act: {
          method: 'POST',
          path: '/act',
          desc: 'Act on one kind',
          input: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('a'), a: z.string() }),
            z.object({ kind: z.literal('b'), b: z.number() }),
          ]),
          output: z.object({ ok: z.boolean() }),
          tool: { name: 'act_tool' },
        },
      },
    );
    const service = createImplement<RuntimeContext>()(contract, { act: () => ({ ok: true }) });
    const extend = { schema: { tenant: z.string().describe('Tenant') }, resolve: () => ({}) };
    const shapes = async (projection: {
      extend?: typeof extend;
      flattenUnionInput?: boolean;
    }) => {
      let ranked: readonly { name: string; inputSchema: Record<string, unknown> }[] = [];
      const deferred = createDeferredAgentToolSurface({
        services: [service],
        ...projection,
        search: {
          name: 'tool_search',
          maxQueryBytes: 32,
          maxResults: 1,
          maxResultBytes: 512,
          select: ({ manifest }) => {
            ranked = manifest;
            return [];
          },
        },
        activation: { maxSelectedTools: 1, maxActiveTools: 2, maxSchemaBytes: 8_192 },
      });
      const tools = deferred.mount(runContext, { access: { open: 'local-operator' } });
      await searchExecutor(tools)(
        { query: 'act' },
        { toolCallId: 'search', messages: [], context: undefined },
      );
      const mountedTool = tools.act_tool;
      if (!mountedTool) throw new Error('expected the act tool');
      const mounted = await asSchema(mountedTool.inputSchema).jsonSchema;
      const listed = ranked.find((entry) => entry.name === 'act_tool')?.inputSchema;
      return [mounted, listed].map((schema) => ({
        tenant: JSON.stringify(schema).includes('"tenant"'),
        flat:
          !JSON.stringify(schema).includes('anyOf') &&
          !JSON.stringify(schema).includes('oneOf'),
      }));
    };
    expect(await shapes({ extend, flattenUnionInput: true })).toEqual([
      { tenant: true, flat: true },
      { tenant: true, flat: true },
    ]);
    // Without them neither the manifest nor the mount changes.
    expect(await shapes({})).toEqual([
      { tenant: false, flat: false },
      { tenant: false, flat: false },
    ]);
  });
});
