/**
 * Cross-surface propagation of `endpoint.effect` (`'read' | 'write'`) from
 * contract and runtime-tool declarations through `OperationIdentity`/`MethodDef`
 * into HTTP hooks, tool lifecycle gates, MCP annotations, catalog stamps, and
 * CLI repeatable-read classification.
 */
import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createHttpClient } from '../src/browser/http';
import { AppError } from '../src/contract/errors';
import {
  createContractFactory,
  defineContract,
  type OperationEffect,
  withToolView,
} from '../src/entrypoints/contract';
import { implementRemote } from '../src/entrypoints/remote';
import { createHandler, createScopedImplement, implement } from '../src/entrypoints/server';
import { createRuntimeToolFactory, defineRuntimeTool } from '../src/entrypoints/tools';
import { mountAgent } from '../src/entrypoints/tools/agent';
import { buildMcpServer } from '../src/entrypoints/tools/mcp';
import { projectRuntimeTool } from '../src/tools/internal/surface-projector';
import { mcpCatalogStamp } from '../src/tools/mcp/catalog';
import { prepareMcpServerSurface } from '../src/tools/mcp/prepare';
import { isRepeatableRead, publishedToolAnnotations } from '../src/tools/read-operation';
import { runtimeToolMountable } from '../src/tools/runtime-tool';
import { runCliSurface } from './support/operation-transports';

const ItemRow = z.object({ id: z.string(), name: z.string() });
const ItemList = z.array(ItemRow);
const OpenItemList = z.array(z.looseObject({ id: z.string(), name: z.string() }));
const SAMPLE_ITEMS = [
  { id: 'i1', name: 'alpha' },
  { id: 'i2', name: 'beta' },
];

function executable(tools: ReturnType<typeof mountAgent>, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool "${name}"`);
  return execute;
}

describe('HTTP hooks observe endpoint.effect on MethodDef', () => {
  const contract = defineContract(
    { prefix: 'records', scope: 'public' },
    {
      search: {
        method: 'POST',
        path: '/search',
        desc: 'Query records via POST',
        effect: 'read',
        input: z.object({ q: z.string() }),
        output: z.object({ hits: z.number() }),
      },
      rotate: {
        method: 'GET',
        path: '/rotate',
        desc: 'Rotate secret via GET',
        effect: 'write',
        output: z.object({ rotated: z.boolean() }),
      },
      legacy: {
        method: 'GET',
        path: '/legacy',
        desc: 'Legacy endpoint without effect',
        output: z.object({ ok: z.boolean() }),
      },
      failWrite: {
        method: 'POST',
        path: '/fail',
        desc: 'Failing write endpoint',
        effect: 'write',
        output: z.object({ ok: z.boolean() }),
      },
    },
  );

  const service = implement(contract, {
    search: ({ input }) => ({ hits: input.q.length }),
    rotate: () => ({ rotated: true }),
    legacy: () => ({ ok: true }),
    failWrite: () => {
      throw new AppError('CONFLICT', { message: 'write failed', status: 409 });
    },
  });

  test('implement carries endpoint.effect onto MethodDef', () => {
    expect(service.methods.search?.effect).toBe('read');
    expect(service.methods.rotate?.effect).toBe('write');
    expect(service.methods.legacy?.effect).toBeUndefined();
    expect(service.methods.failWrite?.effect).toBe('write');
  });

  test('global and group authorize, beforeHandle, afterHandle and onError receive endpoint.effect', async () => {
    const events: Array<{ hook: string; key: string; effect: OperationEffect | undefined }> =
      [];

    const handler = createHandler({
      groups: [
        {
          services: [service],
          hooks: {
            authorize: (_ctx, endpoint) => {
              events.push({
                hook: 'group.authorize',
                key: endpoint.key,
                effect: endpoint.effect,
              });
            },
            beforeHandle: (_ctx, endpoint) => {
              events.push({
                hook: 'group.beforeHandle',
                key: endpoint.key,
                effect: endpoint.effect,
              });
            },
          },
        },
      ],
      hooks: {
        authorize: (_ctx, endpoint) => {
          events.push({ hook: 'authorize', key: endpoint.key, effect: endpoint.effect });
        },
        beforeHandle: (_ctx, endpoint) => {
          events.push({ hook: 'beforeHandle', key: endpoint.key, effect: endpoint.effect });
        },
        afterHandle: (_ctx, result, endpoint) => {
          events.push({ hook: 'afterHandle', key: endpoint.key, effect: endpoint.effect });
          return result;
        },
        onError: (_ctx, _error, endpoint) => {
          if (endpoint) {
            events.push({ hook: 'onError', key: endpoint.key, effect: endpoint.effect });
          }
          return undefined;
        },
      },
    });

    const searchRes = await handler(
      new Request('http://localhost/records/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'hello' }),
      }),
    );
    expect(searchRes.status).toBe(200);

    const rotateRes = await handler(new Request('http://localhost/records/rotate'));
    expect(rotateRes.status).toBe(200);

    const legacyRes = await handler(new Request('http://localhost/records/legacy'));
    expect(legacyRes.status).toBe(200);

    const failRes = await handler(
      new Request('http://localhost/records/fail', { method: 'POST' }),
    );
    expect(failRes.status).toBe(409);

    expect(events).toEqual([
      { hook: 'authorize', key: 'search', effect: 'read' },
      { hook: 'group.authorize', key: 'search', effect: 'read' },
      { hook: 'beforeHandle', key: 'search', effect: 'read' },
      { hook: 'group.beforeHandle', key: 'search', effect: 'read' },
      { hook: 'afterHandle', key: 'search', effect: 'read' },
      { hook: 'authorize', key: 'rotate', effect: 'write' },
      { hook: 'group.authorize', key: 'rotate', effect: 'write' },
      { hook: 'beforeHandle', key: 'rotate', effect: 'write' },
      { hook: 'group.beforeHandle', key: 'rotate', effect: 'write' },
      { hook: 'afterHandle', key: 'rotate', effect: 'write' },
      { hook: 'authorize', key: 'legacy', effect: undefined },
      { hook: 'group.authorize', key: 'legacy', effect: undefined },
      { hook: 'beforeHandle', key: 'legacy', effect: undefined },
      { hook: 'group.beforeHandle', key: 'legacy', effect: undefined },
      { hook: 'afterHandle', key: 'legacy', effect: undefined },
      { hook: 'authorize', key: 'failWrite', effect: 'write' },
      { hook: 'group.authorize', key: 'failWrite', effect: 'write' },
      { hook: 'beforeHandle', key: 'failWrite', effect: 'write' },
      { hook: 'group.beforeHandle', key: 'failWrite', effect: 'write' },
      { hook: 'onError', key: 'failWrite', effect: 'write' },
    ]);
  });
});

describe('withToolView, createContractFactory, createScopedImplement and implementRemote preserve effect', () => {
  const configuredFactory = createContractFactory<'reader' | 'writer'>().configure({
    toolExposure: { default: ['HTTP', 'MCP', 'AGENT', 'CLI'] },
  });
  const plainFactory = createContractFactory<'reader' | 'writer'>();

  const FullOutput = z.object({
    items: ItemList,
    internalToken: z.string(),
  });
  const ViewOutput = z.object({ items: ItemList });

  const configuredContract = configuredFactory.defineContract(
    { prefix: 'catalog', scope: 'reader' },
    {
      query: withToolView(
        {
          method: 'POST',
          path: '/query',
          desc: 'Query catalog with tool view',
          effect: 'read',
          input: z.object({ limit: z.number().default(50) }),
          output: FullOutput,
          tool: { name: 'catalog_query' },
        },
        {
          defaults: { limit: 10 },
          output: ViewOutput,
          project: (full) => ({ items: full.items }),
        },
      ),
      mutate: {
        method: 'GET',
        path: '/mutate',
        desc: 'Mutate catalog via GET',
        scope: 'writer',
        effect: 'write',
        output: z.object({ ok: z.boolean() }),
        tool: { name: 'catalog_mutate' },
      },
      plain: {
        method: 'GET',
        path: '/plain',
        desc: 'Unannotated catalog read',
        output: z.object({ ok: z.boolean() }),
      },
    },
  );

  const plainContract = plainFactory.defineContract(
    { prefix: 'plainCatalog', scope: 'reader' },
    {
      query: withToolView(
        {
          method: 'POST',
          path: '/query',
          desc: 'Plain factory query',
          effect: 'read',
          input: z.object({ limit: z.number().default(50) }),
          output: FullOutput,
        },
        { defaults: { limit: 5 } },
      ),
    },
  );

  test('configured and plain contract factories with withToolView preserve effect through implement, createScopedImplement and implementRemote', () => {
    const localService = implement(configuredContract, {
      query: () => ({ items: SAMPLE_ITEMS, internalToken: 'secret' }),
      mutate: () => ({ ok: true }),
      plain: () => ({ ok: true }),
    });
    expect(localService.methods.query?.effect).toBe('read');
    expect(localService.methods.query?.toolView).toBeDefined();
    expect(localService.methods.mutate?.effect).toBe('write');
    expect(localService.methods.plain?.effect).toBeUndefined();

    const scopedImplement = createScopedImplement<{
      reader: { actor: string };
      writer: { actor: string; canWrite: true };
    }>();
    const scopedService = scopedImplement(configuredContract, {
      query: () => ({ items: SAMPLE_ITEMS, internalToken: 'secret' }),
      mutate: () => ({ ok: true }),
      plain: () => ({ ok: true }),
    });
    expect(scopedService.methods.query?.effect).toBe('read');
    expect(scopedService.methods.mutate?.effect).toBe('write');
    expect(scopedService.methods.plain?.effect).toBeUndefined();

    const remoteService = implementRemote(
      configuredContract,
      createHttpClient({ baseUrl: 'http://localhost' }),
    );
    expect(remoteService.methods.query?.effect).toBe('read');
    expect(remoteService.methods.query?.toolView).toBeDefined();
    expect(remoteService.methods.mutate?.effect).toBe('write');
    expect(remoteService.methods.plain?.effect).toBeUndefined();

    const plainService = implement(plainContract, {
      query: () => ({ items: SAMPLE_ITEMS, internalToken: 'secret' }),
    });
    expect(plainService.methods.query?.effect).toBe('read');
  });
});

describe('ToolGate.beforeHandle and runtimeToolIdentity carry effect across tool surfaces', () => {
  const contract = defineContract(
    { prefix: 'ops', scope: 'public' },
    {
      postRead: {
        method: 'POST',
        path: '/search',
        desc: 'POST read operation',
        effect: 'read',
        expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
        input: z.object({}),
        output: ItemList,
        tool: { name: 'ops_post_read' },
      },
      getWrite: {
        method: 'GET',
        path: '/mutate',
        desc: 'GET write operation',
        effect: 'write',
        expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
        input: z.object({}),
        output: ItemList,
        tool: { name: 'ops_get_write' },
      },
    },
  );

  const service = implement(contract, {
    postRead: () => SAMPLE_ITEMS,
    getWrite: () => SAMPLE_ITEMS,
  });

  const runtimePostRead = defineRuntimeTool({
    name: 'rt_post_read',
    description: 'Runtime POST read tool',
    identity: { serviceName: 'rt', action: 'postRead', method: 'POST', effect: 'read' },
    expose: ['MCP', 'AGENT', 'CLI'],
    input: z.object({}),
    output: ItemList,
    handler: () => SAMPLE_ITEMS,
  });

  const runtimeGetWrite = defineRuntimeTool({
    name: 'rt_get_write',
    description: 'Runtime GET write tool',
    identity: { serviceName: 'rt', action: 'getWrite', method: 'GET', effect: 'write' },
    expose: ['MCP', 'AGENT', 'CLI'],
    input: z.object({}),
    output: ItemList,
    handler: () => SAMPLE_ITEMS,
  });

  const runtimePlain = defineRuntimeTool({
    name: 'rt_plain_get',
    description: 'Runtime GET without explicit effect',
    identity: { serviceName: 'rt', action: 'plainGet', method: 'GET' },
    expose: ['MCP', 'AGENT', 'CLI'],
    input: z.object({}),
    output: ItemList,
    handler: () => SAMPLE_ITEMS,
  });

  test('runtimeToolMountable forwards identity.effect onto OperationIdentity', () => {
    expect(runtimeToolMountable(projectRuntimeTool(runtimePostRead)).method.effect).toBe(
      'read',
    );
    expect(runtimeToolMountable(projectRuntimeTool(runtimeGetWrite)).method.effect).toBe(
      'write',
    );
    expect(
      runtimeToolMountable(projectRuntimeTool(runtimePlain)).method.effect,
    ).toBeUndefined();
  });

  test('defineRuntimeTool and runtimeToolMountable reject invalid effect values at runtime', () => {
    const badIdentity = JSON.parse(
      '{"serviceName":"rt","action":"bad","method":"POST","effect":"admin"}',
    );
    expect(() =>
      defineRuntimeTool({
        name: 'rt_bad_effect',
        description: 'Invalid effect',
        identity: badIdentity,
        input: z.object({}),
        handler: () => undefined,
      }),
    ).toThrow(/invalid effect "admin"/i);

    expect(() =>
      runtimeToolMountable(
        projectRuntimeTool({
          name: 'rt_bad_inline',
          description: 'Invalid inline effect',
          identity: badIdentity,
          input: z.object({}),
          handler: () => undefined,
        }),
      ),
    ).toThrow(/invalid effect "admin"/i);
  });

  test('createRuntimeToolFactory forwards effect for tools with and without output', async () => {
    const factory = createRuntimeToolFactory({
      serviceName: 'factorySvc',
      scope: 'user',
      context: z.object({ actor: z.string() }),
    });

    const withOutput = factory.define({
      name: 'factory_read',
      action: 'readItem',
      method: 'POST',
      effect: 'read',
      description: 'Read via factory',
      input: z.object({}),
      output: z.object({ actor: z.string() }),
      handler: ({ actor }) => ({ actor }),
    });

    const withoutOutput = factory.define({
      name: 'factory_write',
      action: 'writeItem',
      method: 'GET',
      effect: 'write',
      description: 'Write via factory without output',
      input: z.object({}),
      handler: () => undefined,
    });

    expect(withOutput.identity.effect).toBe('read');
    expect('effect' in withOutput).toBe(false);
    expect(withoutOutput.identity.effect).toBe('write');
    expect('effect' in withoutOutput).toBe(false);

    const seen: Array<{ key: string; effect: OperationEffect | undefined }> = [];
    const tools = mountAgent([], {
      context: { actor: 'alice' },
      runtimeTools: [withOutput, withoutOutput],
      access: {
        gate: {
          beforeHandle: (_ctx, endpoint) => {
            seen.push({ key: endpoint.key, effect: endpoint.effect });
          },
        },
      },
    });

    await executable(tools, 'factory_read')(
      {},
      { toolCallId: 'f1', messages: [], context: undefined },
    );
    await executable(tools, 'factory_write')(
      {},
      { toolCallId: 'f2', messages: [], context: undefined },
    );

    expect(seen).toEqual([
      { key: 'readItem', effect: 'read' },
      { key: 'writeItem', effect: 'write' },
    ]);
  });

  test('ToolGate.beforeHandle and ToolCallHooks receive effect on Agent, MCP, and CLI', async () => {
    const agentSeen: Array<{
      hook: string;
      key: string;
      effect: OperationEffect | undefined;
    }> = [];
    const tools = mountAgent([service], {
      runtimeTools: [runtimePostRead, runtimeGetWrite, runtimePlain],
      access: {
        gate: {
          beforeHandle: (_ctx, endpoint) => {
            agentSeen.push({ hook: 'gate', key: endpoint.key, effect: endpoint.effect });
          },
        },
      },
      hooks: {
        beforeToolCall: ({ endpoint }) => {
          agentSeen.push({ hook: 'before', key: endpoint.key, effect: endpoint.effect });
        },
        afterToolCall: ({ endpoint }) => {
          agentSeen.push({ hook: 'after', key: endpoint.key, effect: endpoint.effect });
        },
      },
    });

    for (const name of [
      'ops_post_read',
      'ops_get_write',
      'rt_post_read',
      'rt_get_write',
      'rt_plain_get',
    ]) {
      await executable(tools, name)(
        {},
        { toolCallId: name, messages: [], context: undefined },
      );
    }

    expect(agentSeen).toEqual([
      { hook: 'before', key: 'postRead', effect: 'read' },
      { hook: 'gate', key: 'postRead', effect: 'read' },
      { hook: 'after', key: 'postRead', effect: 'read' },
      { hook: 'before', key: 'getWrite', effect: 'write' },
      { hook: 'gate', key: 'getWrite', effect: 'write' },
      { hook: 'after', key: 'getWrite', effect: 'write' },
      { hook: 'before', key: 'postRead', effect: 'read' },
      { hook: 'gate', key: 'postRead', effect: 'read' },
      { hook: 'after', key: 'postRead', effect: 'read' },
      { hook: 'before', key: 'getWrite', effect: 'write' },
      { hook: 'gate', key: 'getWrite', effect: 'write' },
      { hook: 'after', key: 'getWrite', effect: 'write' },
      { hook: 'before', key: 'plainGet', effect: undefined },
      { hook: 'gate', key: 'plainGet', effect: undefined },
      { hook: 'after', key: 'plainGet', effect: undefined },
    ]);

    // MCP ToolGate.beforeHandle
    const mcpSeen: Array<{ key: string; effect: OperationEffect | undefined }> = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'effect-mcp-test', version: '1' });
    const server = buildMcpServer({
      serverInfo: { name: 'ops', version: '1' },
      services: [service],
      runtimeTools: [runtimePostRead, runtimeGetWrite],
      access: {
        gate: {
          beforeHandle: (_ctx, endpoint) => {
            mcpSeen.push({ key: endpoint.key, effect: endpoint.effect });
          },
        },
      },
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: 'ops_post_read', arguments: {} });
    await client.callTool({ name: 'rt_get_write', arguments: {} });
    await client.close();
    expect(mcpSeen).toEqual([
      { key: 'postRead', effect: 'read' },
      { key: 'getWrite', effect: 'write' },
    ]);

    // CLI ToolGate.beforeHandle
    const cliSeen: Array<{ key: string; effect: OperationEffect | undefined }> = [];
    const cliResult = await runCliSurface(
      { services: [service], runtimeTools: [runtimePostRead, runtimeGetWrite] },
      ['ops_post_read'],
      {
        access: {
          gate: {
            beforeHandle: (_ctx, endpoint) => {
              cliSeen.push({ key: endpoint.key, effect: endpoint.effect });
            },
          },
        },
      },
    );
    expect(cliResult.code).toBe(0);
    expect(cliSeen).toEqual([{ key: 'postRead', effect: 'read' }]);
  });
});

describe('isRepeatableRead and publishedToolAnnotations honor effect priority', () => {
  test('priority: explicit readOnlyHint > effect write > effect read (unless destructiveHint) > GET fallback', () => {
    // 1. Explicit readOnlyHint overrides effect and destructiveHint in both directions
    expect(
      isRepeatableRead({
        method: 'POST',
        effect: 'write',
        annotations: { readOnlyHint: true },
      }),
    ).toBe(true);
    expect(
      isRepeatableRead({
        method: 'GET',
        effect: 'write',
        annotations: { readOnlyHint: true, destructiveHint: true },
      }),
    ).toBe(true);
    expect(
      isRepeatableRead({
        method: 'POST',
        effect: 'read',
        annotations: { readOnlyHint: false },
      }),
    ).toBe(false);
    expect(
      isRepeatableRead({
        method: 'GET',
        effect: 'read',
        annotations: { readOnlyHint: false },
      }),
    ).toBe(false);

    // 2. effect === 'write' returns false and blocks fallback to GET
    expect(isRepeatableRead({ method: 'GET', effect: 'write' })).toBe(false);
    expect(
      isRepeatableRead({
        method: 'GET',
        effect: 'write',
        annotations: { destructiveHint: false },
      }),
    ).toBe(false);
    expect(isRepeatableRead({ method: 'POST', effect: 'write' })).toBe(false);

    // 3. effect === 'read' returns destructiveHint !== true (including POST)
    expect(isRepeatableRead({ method: 'POST', effect: 'read' })).toBe(true);
    expect(
      isRepeatableRead({
        method: 'POST',
        effect: 'read',
        annotations: { destructiveHint: false },
      }),
    ).toBe(true);
    expect(
      isRepeatableRead({
        method: 'POST',
        effect: 'read',
        annotations: { destructiveHint: true },
      }),
    ).toBe(false);
    expect(
      isRepeatableRead({
        method: 'GET',
        effect: 'read',
        annotations: { destructiveHint: true },
      }),
    ).toBe(false);

    // 4. Fallback when effect is omitted: GET && destructiveHint !== true
    expect(isRepeatableRead({ method: 'GET' })).toBe(true);
    expect(isRepeatableRead({ method: 'GET', annotations: { destructiveHint: true } })).toBe(
      false,
    );
    expect(isRepeatableRead({ method: 'POST' })).toBe(false);
  });

  test('publishedToolAnnotations reflects effect priority without mutating explicit hints', () => {
    expect(publishedToolAnnotations({ method: 'POST', effect: 'read' })).toEqual({
      readOnlyHint: true,
    });
    expect(
      publishedToolAnnotations({
        method: 'POST',
        effect: 'read',
        annotations: { destructiveHint: true, title: 'Danger Read' },
      }),
    ).toEqual({ destructiveHint: true, title: 'Danger Read' });
    expect(publishedToolAnnotations({ method: 'GET', effect: 'write' })).toBeUndefined();
    expect(
      publishedToolAnnotations({
        method: 'GET',
        effect: 'write',
        annotations: { title: 'Mutating GET' },
      }),
    ).toEqual({ title: 'Mutating GET' });
    expect(
      publishedToolAnnotations({
        method: 'GET',
        effect: 'write',
        annotations: { readOnlyHint: true },
      }),
    ).toEqual({ readOnlyHint: true });
    expect(
      publishedToolAnnotations({
        method: 'POST',
        effect: 'read',
        annotations: { readOnlyHint: false },
      }),
    ).toEqual({ readOnlyHint: false });
  });

  test('MCP tools/list, catalog stamp, and CLI refused-view honor effect across contract and runtime tools', async () => {
    let executedCount = 0;
    const answer = () => {
      executedCount += 1;
      return SAMPLE_ITEMS;
    };

    const contract = defineContract(
      { prefix: 'effects', scope: 'public' },
      {
        postRead: {
          method: 'POST',
          path: '/post-read',
          desc: 'POST read',
          effect: 'read',
          expose: ['MCP', 'CLI'],
          output: OpenItemList,
          tool: { name: 'fx_post_read' },
        },
        postReadDestructive: {
          method: 'POST',
          path: '/post-read-destructive',
          desc: 'POST read marked destructive',
          effect: 'read',
          expose: ['MCP', 'CLI'],
          output: OpenItemList,
          tool: { name: 'fx_post_read_destructive', annotations: { destructiveHint: true } },
        },
        postReadExplicitFalse: {
          method: 'POST',
          path: '/post-read-false',
          desc: 'POST read with explicit readOnlyHint false',
          effect: 'read',
          expose: ['MCP', 'CLI'],
          output: OpenItemList,
          tool: { name: 'fx_post_read_false', annotations: { readOnlyHint: false } },
        },
        getWrite: {
          method: 'GET',
          path: '/get-write',
          desc: 'GET write',
          effect: 'write',
          expose: ['MCP', 'CLI'],
          output: OpenItemList,
          tool: { name: 'fx_get_write' },
        },
        getWriteExplicitTrue: {
          method: 'GET',
          path: '/get-write-true',
          desc: 'GET write with explicit readOnlyHint true',
          effect: 'write',
          expose: ['MCP', 'CLI'],
          output: OpenItemList,
          tool: { name: 'fx_get_write_true', annotations: { readOnlyHint: true } },
        },
      },
    );

    const service = implement(contract, {
      postRead: answer,
      postReadDestructive: answer,
      postReadExplicitFalse: answer,
      getWrite: answer,
      getWriteExplicitTrue: answer,
    });

    const rtPostRead = defineRuntimeTool({
      name: 'fx_rt_post_read',
      description: 'Runtime POST read',
      identity: { serviceName: 'fx', action: 'rtPostRead', method: 'POST', effect: 'read' },
      expose: ['MCP', 'CLI'],
      input: z.object({}),
      output: OpenItemList,
      handler: answer,
    });

    const rtGetWrite = defineRuntimeTool({
      name: 'fx_rt_get_write',
      description: 'Runtime GET write',
      identity: { serviceName: 'fx', action: 'rtGetWrite', method: 'GET', effect: 'write' },
      expose: ['MCP', 'CLI'],
      input: z.object({}),
      output: OpenItemList,
      handler: answer,
    });

    // Verify MCP tools/list annotations
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fx-annotations', version: '1' });
    const server = buildMcpServer({
      access: { open: 'local-operator' },
      serverInfo: { name: 'effects', version: '1' },
      services: [service],
      runtimeTools: [rtPostRead, rtGetWrite],
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    expect(byName.fx_post_read).toEqual({ readOnlyHint: true });
    expect(byName.fx_post_read_destructive).toEqual({ destructiveHint: true });
    expect(byName.fx_post_read_false).toEqual({ readOnlyHint: false });
    expect(byName.fx_get_write).toBeUndefined();
    expect(byName.fx_get_write_true).toEqual({ readOnlyHint: true });
    expect(byName.fx_rt_post_read).toEqual({ readOnlyHint: true });
    expect(byName.fx_rt_get_write).toBeUndefined();

    // Verify MCP catalog stamp changes when effect changes readOnlyHint publication
    const stampFor = (method: 'GET' | 'POST', effect?: OperationEffect) => {
      const c = defineContract(
        { prefix: 'stamp', scope: 'public' },
        {
          op: {
            method,
            path: '/op',
            desc: 'Op',
            ...(effect !== undefined && { effect }),
            expose: ['MCP'],
            output: ItemList,
            tool: { name: 'stamp_op' },
          },
        },
      );
      return mcpCatalogStamp(
        prepareMcpServerSurface({ services: [implement(c, { op: () => SAMPLE_ITEMS })] }),
      ).digest;
    };
    expect(stampFor('POST', 'read')).not.toBe(stampFor('POST'));
    expect(stampFor('GET', 'write')).not.toBe(stampFor('GET'));
    expect(stampFor('GET', 'read')).toBe(stampFor('GET'));

    // Verify CLI refused-view withholds stdout for repeatable reads and keeps stdout for non-reads
    const surface = { services: [service], runtimeTools: [rtPostRead, rtGetWrite] };

    for (const readCommand of ['fx_post_read', 'fx_get_write_true', 'fx_rt_post_read']) {
      const before = executedCount;
      const res = await runCliSurface(surface, [readCommand, '--table', 'id,nosuchcolumn']);
      expect(executedCount).toBe(before + 1);
      expect(res.code).toBe(8);
      expect(res.out).toBe('');
      expect(JSON.parse(res.err).details.resultOnStdout).toBe(false);
    }

    for (const nonReadCommand of [
      'fx_post_read_destructive',
      'fx_post_read_false',
      'fx_get_write',
      'fx_rt_get_write',
    ]) {
      const before = executedCount;
      const res = await runCliSurface(surface, [nonReadCommand, '--table', 'id,nosuchcolumn']);
      expect(executedCount).toBe(before + 1);
      expect(res.code).toBe(8);
      expect(JSON.parse(res.out)).toEqual(SAMPLE_ITEMS);
      expect(JSON.parse(res.err).details.resultOnStdout).toBe(true);
    }
  });
});
