import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import type { StitchLogger } from '../src/server';
import { implement } from '../src/server';
import {
  buildMcpServer,
  buildMcpServerFromPrepared,
  type McpServerBuildConfig,
  prepareMcpSurface,
} from '../src/tools/mcp';
import { createMcpHandler } from '../src/tools/mcp-handler';

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
  return new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: identity,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'cache-test', version: '1' },
      },
    }),
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
    const prepared = prepareMcpSurface(services);
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
      sessionMode: 'stateless',
      schemaValidation: { policy: 'warn', requirePortableFormats: true },
      logger: recordingLogger(warnings),
      context: () => {
        contexts += 1;
        return { requestNumber: contexts };
      },
      nativeTools: () => {
        servers += 1;
      },
    });

    expect(warnings).toHaveLength(1);
    expect((await handler(initializeRequest())).status).toBe(200);
    expect((await handler(initializeRequest())).status).toBe(200);
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
      sessionMode: 'stateless',
      schemaValidation: { policy: 'warn', requirePortableFormats: true },
      logger: recordingLogger(warnings),
    });

    expect(warnings).toEqual([]);
    expect((await handler(initializeRequest('alpha'))).status).toBe(200);
    expect((await handler(initializeRequest('beta'))).status).toBe(200);
    expect(identities).toEqual(['alpha', 'beta']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('alpha_get');
    expect(warnings[1]).toContain('beta_get');
  });
});
