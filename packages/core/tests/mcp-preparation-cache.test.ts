import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import type { StitchLogger } from '../src/server';
import { implement } from '../src/server';
import {
  buildMcpServer,
  buildMcpServerFromPrepared,
  type McpServerBuildConfig,
  prepareMcpServerSurface,
  prepareMcpSurface,
} from '../src/tools/mcp';
import { createMcpHandler } from '../src/tools/mcp-handler';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

function serviceFor(toolName: string, idSchema: z.ZodType = z.string()) {
  return implement(
    defineContract(
      { prefix: toolName },
      {
        get: {
          method: 'GET',
          path: '/:id',
          desc: `Get ${toolName}`,
          toolName,
          params: z.object({ id: idSchema }),
          output: z.object({ value: z.string() }),
        },
      },
    ),
    { get: ({ params }) => ({ value: String(params.id) }) },
  );
}

function initializeRequest(identity = 'static'): Request {
  return rpcRequest('initialize', identity);
}

function rpcRequest(
  method: string,
  identity = 'static',
  sessionId?: string,
  params: Record<string, unknown> = {},
): Request {
  return new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: identity,
      ...(sessionId && { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...(method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'cache-test', version: '1' },
            }
          : params),
      },
    }),
  });
}

async function rpcBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(data ?? text);
}

function listedToolNames(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.tools)) {
    return [];
  }
  return body.result.tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
  );
}

function runtimeToolFor(name: string) {
  return defineRuntimeTool({
    name,
    description: `Run ${name}`,
    identity: { serviceName: 'runtime', action: name, method: 'POST' },
    input: z.object({}),
    handler: () => undefined,
  });
}

function recordingLogger(messages: string[]): StitchLogger {
  return {
    info: () => undefined,
    warn: (message) => messages.push(message),
    error: () => undefined,
    debug: () => undefined,
  };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cache-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('immutable MCP surface preparation', () => {
  test('freezes the descriptor set without capturing runtime state', () => {
    const prepared = prepareMcpSurface([serviceFor('entity_get')]);

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared[0])).toBe(true);
    expect(Object.isFrozen(prepared[0]?.mountable)).toBe(true);
    expect(prepared[0]?.mountable.name).toBe('entity_get');
  });

  test('prepared and direct builds advertise and execute the same surface', async () => {
    const services = [serviceFor('entity_get')];
    let beforeCalls = 0;
    let afterCalls = 0;
    let hookCalls = 0;
    const config: McpServerBuildConfig<undefined> = {
      serverInfo: { name: 'test', version: '1' },
      services,
      lifecycle: {
        beforeHandle: () => {
          beforeCalls += 1;
        },
        afterHandle: (_context, result) => {
          afterCalls += 1;
          return result;
        },
      },
      hooks: {
        afterToolCall: () => {
          hookCalls += 1;
        },
      },
    };
    const directClient = await connect(buildMcpServer(config, undefined));
    const prepared = prepareMcpServerSurface({ services });
    const preparedClient = await connect(
      buildMcpServerFromPrepared(config, undefined, prepared),
    );

    expect(await preparedClient.listTools()).toEqual(await directClient.listTools());
    expect(
      await preparedClient.callTool({ name: 'entity_get', arguments: { id: '42' } }),
    ).toEqual(await directClient.callTool({ name: 'entity_get', arguments: { id: '42' } }));
    expect({ beforeCalls, afterCalls, hookCalls }).toEqual({
      beforeCalls: 2,
      afterCalls: 2,
      hookCalls: 2,
    });

    await Promise.all([directClient.close(), preparedClient.close()]);
  });
});

describe('static handler preparation cache', () => {
  test('validates once while creating a fresh server and context per request', async () => {
    const warnings: string[] = [];
    let contexts = 0;
    let servers = 0;
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => ({ id: 'static' }),
      services: [serviceFor('entity_get', z.cuid2())],
      schemaValidation: { policy: 'warn', requirePortableFormats: true },
      logger: recordingLogger(warnings),
      context: () => {
        contexts += 1;
        return { requestNumber: contexts };
      },
      rawTools: () => {
        servers += 1;
      },
    });

    expect(warnings).toHaveLength(1);
    expect((await handler.fetch(initializeRequest())).status).toBe(200);
    expect((await handler.fetch(initializeRequest())).status).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(contexts).toBe(2);
    expect(servers).toBe(2);
  });
});

describe('identity-dependent surfaces', () => {
  test('resolve and prepare independently for every identity', async () => {
    const warnings: string[] = [];
    const identities: string[] = [];
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: (request) => request.headers.get('authorization'),
      services: (identity) => {
        identities.push(identity);
        return [serviceFor(`${identity}_get`, z.cuid2())];
      },
      schemaValidation: { policy: 'warn', requirePortableFormats: true },
      logger: recordingLogger(warnings),
    });

    expect(warnings).toEqual([]);
    expect((await handler.fetch(initializeRequest('alpha'))).status).toBe(200);
    expect((await handler.fetch(initializeRequest('beta'))).status).toBe(200);
    expect(identities).toEqual(['alpha', 'beta']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('alpha_get');
    expect(warnings[1]).toContain('beta_get');
  });
});

describe('finite prepared surface registry', () => {
  test('eagerly prepares every declared contract and runtime surface once', async () => {
    const warnings: string[] = [];
    const portableWarningTool = defineRuntimeTool({
      name: 'member_lookup',
      description: 'Look up a member',
      identity: { serviceName: 'members', action: 'lookup', method: 'GET' },
      input: z.object({ id: z.ulid() }),
      handler: () => undefined,
    });
    const adminSurface = { services: [serviceFor('admin_get', z.cuid2())] };
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: (request) => ({ role: request.headers.get('authorization') ?? 'member' }),
      surfaces: {
        admin: adminSurface,
        administrator: adminSurface,
        member: { services: [], runtimeTools: [portableWarningTool] },
      },
      selectSurface: (auth) => (auth.role === 'admin' ? 'admin' : 'member'),
      schemaValidation: { policy: 'warn', requirePortableFormats: true },
      logger: recordingLogger(warnings),
    });

    expect(warnings).toHaveLength(2);
    await handler.fetch(initializeRequest('member'));
    await handler.fetch(initializeRequest('admin'));
    await handler.fetch(initializeRequest('member'));
    expect(warnings).toHaveLength(2);
  });

  test('selects exact tool sets from prepared finite surfaces', async () => {
    const surfaces = {
      admin: {
        services: [serviceFor('admin_get')],
        runtimeTools: [runtimeToolFor('admin_action')],
      },
      member: {
        services: [serviceFor('member_get')],
        runtimeTools: [runtimeToolFor('member_action')],
      },
    };
    const directClient = await connect(
      buildMcpServer(
        {
          serverInfo: { name: 'test', version: '1' },
          surfaces,
          selectSurface: (role) => (role === 'admin' ? 'admin' : 'member'),
        },
        'admin',
      ),
    );
    expect((await directClient.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'admin_action',
      'admin_get',
    ]);
    await directClient.close();

    const stateless = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: (request) => request.headers.get('authorization') ?? 'member',
      surfaces,
      selectSurface: (role) => (role === 'admin' ? 'admin' : 'member'),
    });
    const adminNames = listedToolNames(
      await rpcBody(await stateless.fetch(rpcRequest('tools/list', 'admin'))),
    );
    expect(adminNames.sort()).toEqual(['admin_action', 'admin_get']);

    const memberNames = listedToolNames(
      await rpcBody(await stateless.fetch(rpcRequest('tools/list', 'member'))),
    );
    expect(memberNames.sort()).toEqual(['member_action', 'member_get']);
  });

  test('shares descriptors while keeping parallel auth, context and hooks isolated', async () => {
    const seen: string[] = [];
    const whoami = defineRuntimeTool({
      name: 'whoami',
      description: 'Return the current identity',
      identity: { serviceName: 'identity', action: 'read', method: 'GET' },
      input: z.object({ delay: z.number() }),
      output: z.object({ userId: z.string() }),
      handler: async ({ input, userId }) => {
        await new Promise((resolve) => setTimeout(resolve, input.delay));
        return { userId: z.string().parse(userId) };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: (request) => ({ userId: request.headers.get('authorization') ?? 'anonymous' }),
      context: (auth) => auth,
      surfaces: { shared: { services: [], runtimeTools: [whoami] } },
      selectSurface: () => 'shared',
      hooks: {
        afterToolCall: ({ context }) => {
          if (typeof context.userId === 'string') seen.push(context.userId);
        },
      },
    });

    const [alpha, beta] = await Promise.all([
      rpcBody(
        await handler.fetch(
          rpcRequest('tools/call', 'alpha', undefined, {
            name: 'whoami',
            arguments: { delay: 5 },
          }),
        ),
      ),
      rpcBody(
        await handler.fetch(
          rpcRequest('tools/call', 'beta', undefined, {
            name: 'whoami',
            arguments: { delay: 1 },
          }),
        ),
      ),
    ]);

    expect(JSON.stringify(alpha)).toContain('alpha');
    expect(JSON.stringify(beta)).toContain('beta');
    expect(seen.sort()).toEqual(['alpha', 'beta']);
  });

  test('fails first on unknown keys and contract/runtime collisions', async () => {
    const unknown = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => ({ role: 'member' }),
      surfaces: { member: { services: [] } },
      // @ts-expect-error — intentional runtime guard coverage for untyped callers.
      selectSurface: () => 'missing',
    });
    const unknownResponse = await unknown.fetch(initializeRequest());
    expect(unknownResponse.status).toBe(500);

    expect(() =>
      createMcpHandler({
        serverInfo: { name: 'test', version: '1' },
        auth: () => undefined,
        surfaces: {
          broken: {
            services: [serviceFor('duplicate_name')],
            runtimeTools: [runtimeToolFor('duplicate_name')],
          },
        },
        selectSurface: () => 'broken',
      }),
    ).toThrow('Duplicate MCP tool name "duplicate_name"');
  });
});
