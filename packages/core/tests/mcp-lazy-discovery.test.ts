import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineContract, forbidden } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import {
  buildMcpServer,
  createMcpHandler,
  mountMcp,
  readMcpCatalogStamp,
} from '../src/entrypoints/tools/mcp';
import { buildMcpServerFromPrepared, servedMcpCatalog } from '../src/tools/mcp/mount';
import { prepareMcpServerSurface } from '../src/tools/mcp/prepare';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

function makeServices() {
  const health = implement(
    defineContract(
      { prefix: 'health' },
      {
        ping: {
          method: 'GET',
          path: '/ping',
          desc: 'Ping service status',
          output: z.object({ ok: z.boolean() }),
          tool: { name: 'health_ping' },
        },
      },
    ),
    { ping: () => ({ ok: true }) },
  );
  const invoices = implement(
    defineContract(
      { prefix: 'invoices' },
      {
        list: {
          method: 'GET',
          path: '/',
          desc: 'List customer billing invoices',
          input: z.object({ customerId: z.string().min(1) }),
          output: z.object({ items: z.array(z.string()) }),
          tool: { name: 'invoices_list' },
        },
        refund: {
          method: 'POST',
          path: '/refund',
          desc: 'Refund a paid customer invoice',
          input: z.object({ invoiceId: z.string().min(1) }),
          output: z.object({ refunded: z.boolean() }),
          tool: { name: 'invoices_refund' },
        },
      },
    ),
    {
      list: ({ input }) => ({ items: [`inv-${input.customerId}`] }),
      refund: ({ input }) => ({ refunded: input.invoiceId.length > 0 }),
    },
  );
  const inventory = implement(
    defineContract(
      { prefix: 'inventory' },
      {
        check: {
          method: 'GET',
          path: '/check',
          desc: 'Check warehouse stock count',
          input: z.object({ sku: z.string().min(1) }),
          output: z.object({ count: z.number() }),
          tool: { name: 'inventory_check' },
        },
      },
    ),
    { check: () => ({ count: 42 }) },
  );
  return [health, invoices, inventory];
}

async function connectClient(server: McpServer): Promise<{
  readonly client: Client;
  readonly listChangedCount: () => number;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let notifications = 0;
  const client = new Client({ name: 'lazy-discovery-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const previousOnMessage = clientTransport.onmessage;
  clientTransport.onmessage = (message, extra) => {
    if ('method' in message && message.method === 'notifications/tools/list_changed') {
      notifications += 1;
    }
    previousOnMessage?.(message, extra);
  };
  return { client, listChangedCount: () => notifications };
}

describe('opt-in lazy MCP tool discovery', () => {
  test('hides non-initial tools at startup, reveals matched tools with list_changed, preserves hooks, and claims no catalog stamp', async () => {
    const server = new McpServer({ name: 'lazy-test', version: '1.0.0' });
    const calledHooks: string[] = [];
    mountMcp(server, makeServices(), {
      access: { open: 'local-operator' },
      hooks: {
        afterToolCall: ({ toolName }) => {
          calledHooks.push(toolName);
        },
      },
      discovery: {
        mode: 'lazy',
        initialTools: ['health_ping'],
        searchToolName: 'discover_tools',
        maxResults: 1,
      },
    });

    const { client, listChangedCount } = await connectClient(server);
    const initial = await client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(['discover_tools', 'health_ping']);

    // Hidden tool cannot be called before discovery (MCP protocol refuses disabled tools).
    await expect(
      client.callTool({
        name: 'invoices_list',
        arguments: { customerId: 'c1' },
      }),
    ).rejects.toThrow(/disabled/i);

    // Search honors maxResults: 1 and sends exactly one notifications/tools/list_changed.
    const found = await client.callTool({
      name: 'discover_tools',
      arguments: { query: 'invoices_list', limit: 10 },
    });
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent).toEqual({
      query: 'invoices_list',
      enabledTools: ['invoices_list'],
      matches: [
        {
          name: 'invoices_list',
          description: 'List customer billing invoices',
          newlyEnabled: true,
        },
      ],
      totalHiddenRemaining: 2,
    });
    // Each session lists its own subset, which no digest of the whole surface describes (ADR 0293).
    expect(readMcpCatalogStamp(found._meta)).toBeNull();
    expect(initial.tools.map((t) => readMcpCatalogStamp(t._meta))).toEqual([null, null]);
    expect(listChangedCount()).toBe(1);

    // Revealed tool appears in tools/list and executes with full Zod validation and hooks, unstamped.
    const afterList = await client.listTools();
    expect(afterList.tools.map((t) => t.name).sort()).toEqual([
      'discover_tools',
      'health_ping',
      'invoices_list',
    ]);
    const invoicesMeta = afterList.tools.find((t) => t.name === 'invoices_list')?._meta;
    expect(readMcpCatalogStamp(invoicesMeta)).toBeNull();
    const revealedCall = await client.callTool({
      name: 'invoices_list',
      arguments: { customerId: 'acme' },
    });
    expect(revealedCall.isError).not.toBe(true);
    expect(revealedCall.structuredContent).toEqual({ items: ['inv-acme'] });
    expect(readMcpCatalogStamp(revealedCall._meta)).toBeNull();
    expect(calledHooks).toContain('discover_tools');
    expect(calledHooks).toContain('invoices_list');

    // Re-searching an already enabled tool or finding zero matches emits zero notifications.
    const countBeforeRepeat = listChangedCount();
    const repeat = await client.callTool({
      name: 'discover_tools',
      arguments: { query: 'invoices_list' },
    });
    expect(repeat.structuredContent).toEqual({
      query: 'invoices_list',
      enabledTools: [],
      matches: [
        {
          name: 'invoices_list',
          description: 'List customer billing invoices',
          newlyEnabled: false,
        },
      ],
      totalHiddenRemaining: 2,
    });
    const noMatch = await client.callTool({
      name: 'discover_tools',
      arguments: { query: '[a-z]+.*(zzz_nonexistent' },
    });
    expect(noMatch.isError).not.toBe(true);
    expect(noMatch.structuredContent).toEqual({
      query: '[a-z]+.*(zzz_nonexistent',
      enabledTools: [],
      matches: [],
      totalHiddenRemaining: 2,
    });
    const blankQuery = await client.callTool({
      name: 'discover_tools',
      arguments: { query: '   ' },
    });
    expect(blankQuery.isError).toBe(true);
    expect(listChangedCount()).toBe(countBeforeRepeat);
    await client.close();
  });

  test('a repeated search reaches the matches past the first maxResults instead of re-listing enabled ones', async () => {
    const tool = (name: string, desc: string) => ({
      method: 'GET' as const,
      path: `/${name}`,
      desc,
      output: z.object({ ok: z.boolean() }),
      tool: { name },
    });
    const service = implement(
      defineContract(
        { prefix: 'inv' },
        {
          a: tool('invoice_a', 'invoice tool alpha'),
          b: tool('invoice_b', 'invoice tool beta'),
          c: tool('invoice_c', 'invoice tool gamma'),
        },
      ),
      { a: () => ({ ok: true }), b: () => ({ ok: true }), c: () => ({ ok: true }) },
    );
    const server = new McpServer({ name: 'lazy-repeat', version: '1.0.0' });
    mountMcp(server, [service], {
      access: { open: 'local-operator' },
      discovery: { mode: 'lazy', initialTools: [], maxResults: 2 },
    });
    const { client } = await connectClient(server);
    const first = await client.callTool({
      name: 'tool_search',
      arguments: { query: 'invoice' },
    });
    expect(first.structuredContent).toMatchObject({
      enabledTools: ['invoice_a', 'invoice_b'],
      totalHiddenRemaining: 1,
    });
    // Before the fix the enabled tools kept the two slots and invoice_c stayed out of reach.
    const second = await client.callTool({
      name: 'tool_search',
      arguments: { query: 'invoice' },
    });
    expect(second.structuredContent).toEqual({
      query: 'invoice',
      enabledTools: ['invoice_c'],
      matches: [
        { name: 'invoice_c', description: 'invoice tool gamma', newlyEnabled: true },
        { name: 'invoice_a', description: 'invoice tool alpha', newlyEnabled: false },
        { name: 'invoice_b', description: 'invoice tool beta', newlyEnabled: false },
      ],
      totalHiddenRemaining: 0,
    });
  });

  test('batching multiple revealed tools sends exactly one list_changed notification and default eager mount is unchanged', async () => {
    const eagerServer = buildMcpServer({
      serverInfo: { name: 'eager-default', version: '1.0.0' },
      services: makeServices(),
      access: { open: 'local-operator' },
    });
    const eager = await connectClient(eagerServer);
    expect((await eager.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'health_ping',
      'inventory_check',
      'invoices_list',
      'invoices_refund',
    ]);
    await eager.client.close();

    const lazyServer = buildMcpServer({
      serverInfo: { name: 'batch-lazy', version: '1.0.0' },
      services: makeServices(),
      access: { open: 'local-operator' },
      discovery: { mode: 'lazy', initialTools: ['health_ping'], maxResults: 5 },
    });
    // A server built with discovery announces no served catalog, so a connection's catalog store
    // never keys a listing that is only one session's subset; the eager server still does.
    expect(servedMcpCatalog(eagerServer)).toEqual({ digest: expect.any(String), tools: 4 });
    expect(servedMcpCatalog(lazyServer)).toBeUndefined();
    const lazy = await connectClient(lazyServer);
    const result = await lazy.client.callTool({
      name: 'tool_search',
      arguments: { query: 'invoice' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      query: 'invoice',
      enabledTools: ['invoices_list', 'invoices_refund'],
      matches: [
        {
          name: 'invoices_list',
          description: 'List customer billing invoices',
          newlyEnabled: true,
        },
        {
          name: 'invoices_refund',
          description: 'Refund a paid customer invoice',
          newlyEnabled: true,
        },
      ],
      totalHiddenRemaining: 1,
    });
    // Revealing 2 tools in one search must send exactly 1 list_changed notification, not 2.
    expect(lazy.listChangedCount()).toBe(1);
    await lazy.client.close();
  });

  test('enforces access gate and inspect-only policies identically on tool_search and revealed tools', async () => {
    let allowAccess = false;
    const gatedServer = buildMcpServer({
      serverInfo: { name: 'gated-lazy', version: '1.0.0' },
      services: makeServices(),
      access: {
        gate: {
          beforeHandle() {
            if (!allowAccess) throw forbidden('denied');
          },
        },
      },
      discovery: { mode: 'lazy', initialTools: ['health_ping'] },
    });
    const gated = await connectClient(gatedServer);
    const deniedSearch = await gated.client.callTool({
      name: 'tool_search',
      arguments: { query: 'warehouse stock' },
    });
    expect(deniedSearch.isError).toBe(true);
    // Denied search must NOT have enabled inventory_check.
    expect((await gated.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'health_ping',
      'tool_search',
    ]);

    allowAccess = true;
    const allowedSearch = await gated.client.callTool({
      name: 'tool_search',
      arguments: { query: 'warehouse stock' },
    });
    expect(allowedSearch.isError).not.toBe(true);
    expect((await gated.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'health_ping',
      'inventory_check',
      'tool_search',
    ]);

    // Revealed tool itself must still enforce the exact same access gate.
    allowAccess = false;
    const deniedRevealed = await gated.client.callTool({
      name: 'inventory_check',
      arguments: { sku: 'SKU-1' },
    });
    expect(deniedRevealed.isError).toBe(true);

    allowAccess = true;
    const allowedRevealed = await gated.client.callTool({
      name: 'inventory_check',
      arguments: { sku: 'SKU-1' },
    });
    expect(allowedRevealed.isError).not.toBe(true);
    expect(allowedRevealed.structuredContent).toEqual({ count: 42 });
    await gated.client.close();

    // inspect: true refuses tool_search without enabling hidden tools.
    const inspectServer = buildMcpServer({
      serverInfo: { name: 'inspect-lazy', version: '1.0.0' },
      services: makeServices(),
      access: { inspect: true },
      discovery: { mode: 'lazy', initialTools: ['health_ping'] },
    });
    const inspected = await connectClient(inspectServer);
    const inspectResult = await inspected.client.callTool({
      name: 'tool_search',
      arguments: { query: 'invoices' },
    });
    expect(inspectResult.isError).toBe(true);
    expect((await inspected.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'health_ping',
      'tool_search',
    ]);
    await inspected.client.close();
  });

  test('isolates revealed tools per session on a shared prepareMcpServerSurface', async () => {
    const services = makeServices();
    const prepared = prepareMcpServerSurface({ services });
    const config = {
      serverInfo: { name: 'shared-surface', version: '1.0.0' },
      services,
      access: { open: 'local-operator' as const },
      discovery: { mode: 'lazy' as const, initialTools: ['health_ping'] },
    };
    const serverA = buildMcpServerFromPrepared(config, undefined, prepared);
    const serverB = buildMcpServerFromPrepared(config, undefined, prepared);
    const sessionA = await connectClient(serverA);
    const sessionB = await connectClient(serverB);

    await sessionA.client.callTool({
      name: 'tool_search',
      arguments: { query: 'inventory_check' },
    });
    expect((await sessionA.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'health_ping',
      'inventory_check',
      'tool_search',
    ]);
    // Session B stays untouched with only initialTools + tool_search.
    expect((await sessionB.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'health_ping',
      'tool_search',
    ]);

    await Promise.all([sessionA.client.close(), sessionB.client.close()]);
  });

  test('negative controls: synchronously refuses unknown initialTools, name collisions, invalid maxResults, and stateless createMcpHandler', () => {
    const services = makeServices();
    expect(() =>
      mountMcp(new McpServer({ name: 'bad', version: '1' }), services, {
        access: { open: 'local-operator' },
        discovery: { mode: 'lazy', initialTools: ['does_not_exist'] },
      }),
    ).toThrow(/unknown contract tool/i);

    expect(() =>
      mountMcp(new McpServer({ name: 'bad', version: '1' }), services, {
        access: { open: 'local-operator' },
        discovery: {
          mode: 'lazy',
          initialTools: ['health_ping'],
          searchToolName: 'invoices_list',
        },
      }),
    ).toThrow(/collides/i);

    expect(() =>
      buildMcpServer({
        serverInfo: { name: 'bad', version: '1' },
        services,
        runtimeTools: [
          defineRuntimeTool({
            name: 'tool_search',
            description: 'Existing runtime tool',
            identity: { serviceName: 'rt', action: 'search', method: 'POST' },
            input: z.object({}),
            handler: () => undefined,
          }),
        ],
        access: { open: 'local-operator' },
        discovery: { mode: 'lazy', initialTools: ['health_ping'] },
      }),
    ).toThrow(/collides/i);

    expect(() =>
      mountMcp(new McpServer({ name: 'bad', version: '1' }), services, {
        access: { open: 'local-operator' },
        discovery: { mode: 'lazy', initialTools: ['health_ping'], maxResults: 0 },
      }),
    ).toThrow();

    expect(() =>
      mountMcp(new McpServer({ name: 'bad', version: '1' }), services, {
        access: { open: 'local-operator' },
        discovery: { mode: 'lazy', initialTools: ['health_ping'], maxResults: 51 },
      }),
    ).toThrow(RangeError);

    // Stateless HTTP createMcpHandler refuses discovery at compile time and synchronously at runtime.
    expect(() =>
      createMcpHandler({
        serverInfo: { name: 'bad-http', version: '1' },
        services,
        access: { open: 'local-operator' },
        auth: () => ({ ok: true }),
        // @ts-expect-error — stateless HTTP handlers reject lazy discovery at compile time
        discovery: { mode: 'lazy', initialTools: ['health_ping'] },
      }),
    ).toThrow(TypeError);
  });
});
