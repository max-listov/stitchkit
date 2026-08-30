import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  buildToolManifest,
  createRuntimeToolFactory,
  mountAgent,
  type ToolCallHooks,
} from '../src/tools';

function executable(tools: ReturnType<typeof mountAgent>, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

const contextSchema = z.object({
  userId: z.string().min(1),
  tz: z.string().min(1),
});

const factory = createRuntimeToolFactory({
  serviceName: 'agentKnowledge',
  scope: 'user',
  context: contextSchema,
});

const countRecords = factory.define({
  name: 'count_records',
  action: 'countRecords',
  method: 'GET',
  description: 'Count records',
  input: z.object({ kind: z.string() }),
  output: z.object({ owner: z.string(), count: z.number() }),
  handler: ({ userId, tz, input }) => ({
    owner: `${userId}:${tz}:${input.kind}`,
    count: 1,
  }),
});

function compileTimeFactoryChecks(): void {
  factory.define({
    name: 'invalid_identity_override',
    action: 'invalidIdentityOverride',
    method: 'POST',
    description: 'Invalid identity override',
    input: z.object({}),
    // @ts-expect-error identity is bound by the factory
    identity: { serviceName: 'other', action: 'other', method: 'POST' },
    handler: () => undefined,
  });

  factory.define({
    name: 'typed_context',
    action: 'typedContext',
    method: 'GET',
    description: 'Typed context',
    input: z.object({}),
    handler: ({ userId }) => {
      const required: string = userId;
      void required;
      // @ts-expect-error parsed context has no undeclared field
      void userId.missing;
    },
  });

  factory.define({
    name: 'typed_mcp_context',
    action: 'typedMcpContext',
    method: 'GET',
    description: 'Read typed MCP metadata',
    input: z.object({}),
    handler: ({ mcp }) => {
      const clientName: string | undefined = mcp?.clientInfo?.name;
      void clientName;
    },
  });
}
void compileTimeFactoryChecks;

describe('createRuntimeToolFactory', () => {
  test('binds identity and gives handlers parsed context plus parsed input', async () => {
    const seenIdentities: Array<Record<string, unknown>> = [];
    const tools = mountAgent([], {
      context: { userId: 'user-1', tz: 'UTC' },
      runtimeTools: [countRecords],
      lifecycle: {
        beforeHandle: (_context, endpoint) => {
          seenIdentities.push({
            serviceName: endpoint.serviceName,
            action: endpoint.key,
            scope: endpoint.scope,
            method: endpoint.method,
          });
        },
      },
    });

    const result = await executable(tools, 'count_records')(
      { kind: 'notes' },
      { toolCallId: 'count', messages: [], context: undefined },
    );

    expect(result).toEqual({ owner: 'user-1:UTC:notes', count: 1 });
    expect(seenIdentities).toEqual([
      {
        serviceName: 'agentKnowledge',
        action: 'countRecords',
        scope: 'user',
        method: 'GET',
      },
    ]);
  });

  test('invalid context fails through the canonical hooks before the authored handler', async () => {
    let handlerCalls = 0;
    const terminal: string[] = [];
    const hooks: ToolCallHooks = {
      onToolError: () => void terminal.push('error'),
      afterToolCall: ({ result }) => void terminal.push(result.ok ? 'success' : result.code),
    };
    const tool = factory.define({
      name: 'context_guard',
      action: 'contextGuard',
      method: 'POST',
      description: 'Validate context',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        handlerCalls += 1;
        return { ok: true };
      },
    });
    const tools = mountAgent([], {
      context: { userId: 42, tz: 'UTC' },
      runtimeTools: [tool],
      hooks,
    });

    const result = executable(tools, 'context_guard')(
      {},
      { toolCallId: 'guard', messages: [], context: undefined },
    );

    await expect(result).rejects.toMatchObject({
      output: { error: 'VALIDATION_ERROR' },
    });
    expect(handlerCalls).toBe(0);
    expect(terminal).toEqual(['error', 'VALIDATION_ERROR']);
  });

  test('validates context once for each isolated parallel invocation', async () => {
    let parseCount = 0;
    const parallelFactory = createRuntimeToolFactory({
      serviceName: 'parallel',
      context: z.object({
        userId: z.preprocess((value) => {
          parseCount += 1;
          return value;
        }, z.string()),
      }),
    });
    const tool = parallelFactory.define({
      name: 'parallel_context',
      action: 'parallelContext',
      method: 'POST',
      description: 'Use parallel context',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), userId: z.string() }),
      handler: async ({ userId, input }) => {
        await Promise.resolve();
        return { id: input.id, userId };
      },
    });
    const tools = mountAgent([], {
      context: { userId: 'user-1' },
      runtimeTools: [tool],
    });
    const execute = executable(tools, 'parallel_context');

    const results = await Promise.all([
      execute({ id: 'a' }, { toolCallId: 'a', messages: [], context: undefined }),
      execute({ id: 'b' }, { toolCallId: 'b', messages: [], context: undefined }),
    ]);

    expect(results).toEqual([
      { id: 'a', userId: 'user-1' },
      { id: 'b', userId: 'user-1' },
    ]);
    expect(parseCount).toBe(2);
  });

  test('produces ordinary runtime definitions for introspection', () => {
    expect(buildToolManifest({ runtimeTools: [countRecords], transport: 'AGENT' })).toEqual([
      {
        name: 'count_records',
        description: 'Count records',
        inputSchema: expect.objectContaining({ type: 'object' }),
      },
    ]);
  });
});
