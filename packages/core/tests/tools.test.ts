import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppError, defineContract } from '../src/contract';
import { implement } from '../src/server';
import { mountAgent } from '../src/tools/agent';
import { buildMcpServer, mountMcp, validateMcpSchemas } from '../src/tools/mcp';
import { collectTools, createToolRunner } from '../src/tools/mount';

const notesContract = defineContract(
  { prefix: 'notes' },
  {
    list: { method: 'GET', path: '/', desc: 'List notes', output: z.array(z.string()) },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a note',
      input: z.object({ title: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
);
const notesService = implement(notesContract, {
  list: () => ['a'],
  create: () => ({ id: '1' }),
});

const badContract = defineContract(
  { prefix: 'bad' },
  {
    doThing: {
      method: 'POST',
      path: '/',
      desc: 'Has a schema JSON Schema cannot represent',
      input: z.object({ when: z.date() }),
    },
  },
);
const badService = implement(badContract, { doThing: () => undefined });

/** A service whose `send` tool has a non-object (discriminated-union) input. */
const unionContract = defineContract(
  { prefix: 'msg' },
  {
    send: {
      method: 'POST',
      path: '/',
      desc: 'Send a message',
      input: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), text: z.string() }),
        z.object({ kind: z.literal('image'), url: z.string() }),
      ]),
    },
  },
);
const unionService = implement(unionContract, { send: () => undefined });

/** A service whose only endpoint is a multipart upload — HTTP-only, never a tool. */
const multipartContract = defineContract(
  { prefix: 'files' },
  {
    upload: {
      method: 'POST',
      path: '/',
      desc: 'Upload a file',
      multipart: 'file',
      output: z.object({ url: z.string() }),
    },
  },
);
const multipartService = implement(multipartContract, { upload: () => ({ url: 'x' }) });

/** Two services whose `get` methods both resolve to the tool name `get_item`. */
function collidingServices() {
  const make = (prefix: string) =>
    implement(
      defineContract(
        { prefix },
        {
          get: {
            method: 'GET',
            path: '/:id',
            desc: 'Get one',
            params: z.object({ id: z.string() }),
          },
        },
      ),
      { get: () => undefined },
    );
  return [make('item'), make('items')];
}

describe('validateMcpSchemas', () => {
  test('passes a clean service', () => {
    expect(() => validateMcpSchemas({ services: [notesService] })).not.toThrow();
  });

  test('throws on a schema not representable as JSON Schema', () => {
    expect(() => validateMcpSchemas({ services: [badService] })).toThrow('JSON Schema');
  });

  test('throws on a non-object (union) input — MCP needs an object', () => {
    expect(() => validateMcpSchemas({ services: [unionService] })).toThrow(
      'must be an object schema',
    );
  });

  test('warn policy does not throw', () => {
    expect(() => validateMcpSchemas({ services: [badService], policy: 'warn' })).not.toThrow();
  });

  test('skip policy does not throw', () => {
    expect(() => validateMcpSchemas({ services: [badService], policy: 'skip' })).not.toThrow();
  });

  test('throws on a cross-service tool-name collision', () => {
    expect(() => validateMcpSchemas({ services: collidingServices() })).toThrow(
      'Duplicate MCP tool name',
    );
  });

  test('a multipart-only service contributes no tools', () => {
    expect(() => validateMcpSchemas({ services: [multipartService] })).not.toThrow();
  });
});

describe('mountMcp', () => {
  test('registers a clean service without throwing', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() => mountMcp(server, notesService)).not.toThrow();
  });

  test('throws (default policy) on an incompatible schema', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() => mountMcp(server, badService)).toThrow('JSON Schema');
  });

  test('throws (default policy) on a non-object input', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() => mountMcp(server, unionService)).toThrow('must be an object schema');
  });

  test('skip policy drops the tool without throwing', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() =>
      mountMcp(server, badService, { schemaValidation: { policy: 'skip' } }),
    ).not.toThrow();
  });

  test('throws when an extend field collides with a contract field', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() =>
      mountMcp(server, notesService, {
        extend: { schema: { title: z.string() }, resolve: () => ({}) },
      }),
    ).toThrow('extend conflict');
  });
});

describe('buildMcpServer', () => {
  test('forwards extend to mountMcp (batteries-path reaches ToolExtend)', () => {
    // extend was not threaded into buildMcpServer, so createMcpHandler could not
    // add a tool arg. If it now reaches mountMcp → collectTools, a field that
    // collides with the contract throws — proving the passthrough.
    expect(() =>
      buildMcpServer(
        {
          serverInfo: { name: 't', version: '1' },
          services: [notesService],
          extend: { schema: { title: z.string() }, resolve: () => ({}) },
        },
        undefined,
      ),
    ).toThrow('extend conflict');
  });
});

describe('mountAgent', () => {
  test('accepts a single service', () => {
    const tools = mountAgent(notesService);
    expect(Object.keys(tools).sort()).toEqual(['create_note', 'list_notes']);
  });

  test('accepts an array of services', () => {
    const tools = mountAgent([notesService]);
    expect(Object.keys(tools).length).toBe(2);
  });

  test('accepts a non-object (union) input — the agent surface supports unions', () => {
    expect(() => mountAgent(unionService)).not.toThrow();
    expect(Object.keys(mountAgent(unionService))).toEqual(['send_msg']);
  });

  test('a multipart endpoint never becomes a tool', () => {
    expect(Object.keys(mountAgent(multipartService))).toEqual([]);
  });

  test('throws on a cross-service tool-name collision', () => {
    expect(() => mountAgent(collidingServices())).toThrow('Duplicate agent tool name');
  });
});

describe('createToolRunner — the shared mount machinery', () => {
  test('threads lifecycle.beforeHandle — a rejection blocks the call', async () => {
    const [mountable] = collectTools(notesService, 'AGENT', undefined);
    if (!mountable) throw new Error('expected a tool');
    const runner = createToolRunner({
      source: 'agent',
      lifecycle: {
        beforeHandle: () => {
          throw new AppError('FORBIDDEN', 'denied', 403);
        },
      },
    });
    const result = await runner(mountable, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FORBIDDEN');
  });

  test('static context cannot spoof source', async () => {
    let captured: unknown;
    const svc = implement(
      defineContract({ prefix: 'ping' }, { ping: { method: 'GET', path: '/', desc: 'Ping' } }),
      {
        ping: (ctx) => {
          captured = ctx.source;
        },
      },
    );
    const [mountable] = collectTools(svc, 'AGENT', undefined);
    if (!mountable) throw new Error('expected a tool');
    const runner = createToolRunner({ source: 'agent', context: { source: 'mcp' } });
    await runner(mountable, {});
    expect(captured).toBe('agent');
  });
});

describe('MCP round-trip (in-memory transport)', () => {
  async function connect(server: McpServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  test('a non-object output is delivered as structuredContent wrapped in { result }', async () => {
    const server = new McpServer({ name: 't', version: '1' });
    mountMcp(server, notesService);
    const client = await connect(server);
    const res = await client.callTool({ name: 'list_notes', arguments: {} });
    expect(res.structuredContent).toEqual({ result: ['a'] });
    await client.close();
  });

  test('lifecycle.beforeHandle blocks a tool call end-to-end through mountMcp', async () => {
    const server = new McpServer({ name: 't', version: '1' });
    mountMcp(server, notesService, {
      lifecycle: {
        beforeHandle: () => {
          throw new AppError('FORBIDDEN', 'denied', 403);
        },
      },
    });
    const client = await connect(server);
    const res = await client.callTool({ name: 'list_notes', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('FORBIDDEN');
    await client.close();
  });
});
