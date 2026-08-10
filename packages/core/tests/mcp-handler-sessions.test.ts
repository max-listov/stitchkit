import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/contract';
import { createImplement } from '../src/server/implement';
import { createMcpHandler, createMcpHttpRoute } from '../src/tools/mcp-handler';

const contract = defineContract(
  { prefix: 'notes', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List notes',
      expose: ['MCP'],
      output: z.object({ owner: z.string() }),
    },
  },
);

interface TestContext extends RuntimeContext {
  owner: string;
}

const implement = createImplement<TestContext>();
const service = implement(contract, {
  list: async (context) => ({ owner: context.owner }),
});

function legacyRequest(method: string, params?: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: 'localhost',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('createMcpHandler v2 stateless transport', () => {
  test('serves legacy-stateless traffic without protocol sessions', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => ({ owner: 'alpha' }),
      context: (auth) => auth,
      services: [service],
    });

    const initialized = await handler.fetch(
      legacyRequest('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
    );
    expect(initialized.status).toBe(200);
    expect(initialized.headers.has('mcp-session-id')).toBe(false);

    const listed = await handler.fetch(legacyRequest('tools/list', {}));
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('list_notes');
    await handler.close();
  });

  test('resolves auth independently for parallel requests', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: (request) => ({ owner: request.headers.get('authorization') ?? 'none' }),
      context: (auth) => auth,
      services: [service],
    });

    const call = (owner: string) => {
      const request = legacyRequest('tools/call', { name: 'list_notes', arguments: {} });
      request.headers.set('authorization', owner);
      return handler.fetch(request);
    };
    const [alpha, beta] = await Promise.all([call('alpha'), call('beta')]);
    expect(await alpha.text()).toContain('alpha');
    expect(await beta.text()).toContain('beta');
    await handler.close();
  });

  test('applies Host and Origin validation before auth', async () => {
    let authCalls = 0;
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => {
        authCalls += 1;
        return {};
      },
      services: [],
      security: { allowedHosts: ['localhost'], allowedOrigins: ['example.com'] },
    });
    const hostile = legacyRequest('tools/list', {});
    hostile.headers.set('origin', 'https://evil.example');
    expect((await handler.fetch(hostile)).status).toBe(403);
    expect(authCalls).toBe(0);

    const hostileHost = legacyRequest('tools/list', {});
    hostileHost.headers.set('host', 'evil.example');
    expect((await handler.fetch(hostileHost)).status).toBe(403);
    expect(authCalls).toBe(0);
  });

  test('enforces same URL/Host/Origin boundaries without explicit allowlists', async () => {
    let authCalls = 0;
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => {
        authCalls += 1;
        return {};
      },
      services: [],
    });
    const hostileHost = legacyRequest('tools/list', {});
    hostileHost.headers.set('host', 'evil.example');
    expect((await handler.fetch(hostileHost)).status).toBe(403);

    const hostileOrigin = legacyRequest('tools/list', {});
    hostileOrigin.headers.set('origin', 'https://evil.example');
    expect((await handler.fetch(hostileOrigin)).status).toBe(403);

    const sameOrigin = legacyRequest('tools/list', {});
    sameOrigin.headers.set('origin', 'http://localhost');
    expect((await handler.fetch(sameOrigin)).status).toBe(200);
    expect(authCalls).toBe(1);
    await handler.close();
  });

  test('accepts falsy identities because only null means unauthorized', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => 0,
      services: [],
    });
    expect((await handler.fetch(legacyRequest('tools/list', {}))).status).toBe(200);
    await handler.close();
  });

  test('rejects legacy traffic when the endpoint is modern-only', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => ({}),
      services: [],
      legacy: 'reject',
    });
    const response = await handler.fetch(legacyRequest('tools/list', {}));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Unsupported protocol version');
    await handler.close();
  });

  test('close wins a request waiting in async auth without entering the SDK', async () => {
    let resolveAuth: ((auth: object) => void) | undefined;
    const auth = new Promise<object>((resolve) => {
      resolveAuth = resolve;
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => auth,
      services: [],
    });
    const pending = handler.fetch(legacyRequest('tools/list', {}));
    await handler.close();
    resolveAuth?.({});
    const response = await pending;
    expect(response.status).toBe(503);
  });

  test('rejects malformed content and unsupported protocol versions at the wire boundary', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => ({}),
      services: [],
    });

    const wrongContentType = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'text/plain' },
      body: '{}',
    });
    expect((await handler.fetch(wrongContentType)).status).toBe(415);

    const malformed = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: '{not-json',
    });
    expect((await handler.fetch(malformed)).status).toBe(400);

    const unsupported = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': 'tools/list',
        'mcp-protocol-version': '1900-01-01',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const unsupportedResponse = await handler.fetch(unsupported);
    expect(unsupportedResponse.status).toBe(400);
    expect(await unsupportedResponse.text()).toContain('Unsupported protocol version');
    await handler.close();
  });

  test('route adapter delegates to the handler fetch face', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => null,
      services: [],
    });
    const route = createMcpHttpRoute({ path: '/mcp', handler });
    expect(route.method).toBe('ALL');
    expect((await route.handler(legacyRequest('tools/list'), { params: {} })).status).toBe(
      401,
    );
  });
});
