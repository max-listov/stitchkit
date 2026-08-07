/**
 * `createMcpHandler`'s session lifecycle — the only stateful code in the
 * framework, with both the default request-isolated path and explicit sessions.
 *
 * What matters here is not the happy path (that is exercised by every other MCP
 * test through `mountMcp`) but the guarantees the handler makes on its own:
 * identity is resolved before anything else, a session id is **never** minted from
 * a client-supplied value, and the default stateless mode keeps no session at all.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import { implement } from '../src/server';
import { createMcpHandler } from '../src/tools/mcp-handler';

const notes = implement(
  defineContract(
    { prefix: 'notes' },
    { list: { method: 'GET', path: '/', desc: 'List notes', output: z.array(z.string()) } },
  ),
  { list: () => ['a'] },
);

/** The MCP `initialize` call — what a client sends to open a session. */
function initRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://x/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'c', version: '1' },
      },
    }),
  });
}

function toolCallRequest(name: string, headers: Record<string, string> = {}): Request {
  return new Request('http://x/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  });
}

function handlerWith(config: {
  sessionMode?: 'stateful' | 'stateless';
  auth?: (req: Request) => unknown;
}) {
  return createMcpHandler({
    serverInfo: { name: 't', version: '1' },
    auth: config.auth ?? (() => ({ userId: 'u1' })),
    services: [notes],
    ...(config.sessionMode !== undefined && { sessionMode: config.sessionMode }),
  });
}

describe('identity is resolved before anything else', () => {
  test('a null identity is 401, and no session is created', async () => {
    const handler = handlerWith({ auth: () => null });
    const res = await handler(initRequest());
    expect(res.status).toBe(401);
  });

  test('auth runs even for a request carrying a session id', async () => {
    // Otherwise a stolen/guessed id would skip the gate entirely.
    const handler = handlerWith({ auth: () => null });
    const res = await handler(initRequest({ 'mcp-session-id': 'anything' }));
    expect(res.status).toBe(401);
  });
});

describe('a session id is never minted from a client-supplied value', () => {
  test('an unknown session id is rejected 404, not adopted', async () => {
    // The guarantee: a forged or expired id must not cause the server to build a
    // session around it. This is what makes the id unguessable in practice.
    const handler = handlerWith({ sessionMode: 'stateful' });
    const res = await handler(initRequest({ 'mcp-session-id': 'forged-by-client' }));
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(isRecord(body) && isRecord(body.error) ? body.error.code : undefined).toBe(-32001);
    expect(JSON.stringify(body)).toContain('Session not found');
  });

  test('the server issues its own id on a fresh initialize', async () => {
    const handler = handlerWith({ sessionMode: 'stateful' });
    const res = await handler(initRequest());
    expect(res.status).toBe(200);
    const issued = res.headers.get('mcp-session-id');
    expect(issued).toBeTruthy();
    // A UUID, not anything the caller influenced.
    expect(issued).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the issued id is accepted on the next request', async () => {
    const handler = handlerWith({ sessionMode: 'stateful' });
    const issued = (await handler(initRequest())).headers.get('mcp-session-id');
    if (!issued) throw new Error('expected a session id');
    const second = await handler(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': issued,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      }),
    );
    expect(second.status).toBe(200);
  });
});

describe('stateless is the default', () => {
  test('no session id is issued, and an unknown one is not a 404', async () => {
    // With no session store there is nothing to "not find" — the whole 404 branch
    // is bypassed, which is the point: a restarted server never invalidates a
    // client.
    const handler = handlerWith({});
    const first = await handler(initRequest());
    expect(first.status).toBe(200);
    expect(first.headers.get('mcp-session-id')).toBeNull();

    const withId = await handler(initRequest({ 'mcp-session-id': 'whatever' }));
    expect(withId.status).toBe(200);
  });

  test('each request stands alone — a tool call needs no retained handshake', async () => {
    const handler = handlerWith({});
    expect((await handler(initRequest())).status).toBe(200);
    expect((await handler(toolCallRequest('list_notes'))).status).toBe(200);
  });

  test('auth is resolved independently for every request', async () => {
    const identities: string[] = [];
    const handler = handlerWith({
      auth: (request) => {
        const identity = request.headers.get('authorization') ?? 'anonymous';
        identities.push(identity);
        return { identity };
      },
    });

    await handler(initRequest({ authorization: 'alpha' }));
    await handler(initRequest({ authorization: 'beta' }));

    expect(identities).toEqual(['alpha', 'beta']);
  });

  test('parallel requests isolate resolved auth, context and hooks', async () => {
    const seen: string[] = [];
    const handler = createMcpHandler({
      serverInfo: { name: 't', version: '1' },
      auth: (request) => ({ userId: request.headers.get('authorization') ?? 'anonymous' }),
      services: [],
      context: (auth) => auth,
      hooks: {
        afterToolCall: ({ context }) => {
          if (typeof context.userId === 'string') seen.push(context.userId);
        },
      },
      nativeTools: ({ registerTool }) => {
        registerTool({
          name: 'whoami',
          description: 'Return the current identity',
          identity: { serviceName: 'authTools', action: 'whoami', method: 'GET' },
          input: z.object({}),
          handler: () => undefined,
        });
      },
    });

    await Promise.all([
      handler(toolCallRequest('whoami', { authorization: 'alpha' })),
      handler(toolCallRequest('whoami', { authorization: 'beta' })),
    ]);

    expect(seen.sort()).toEqual(['alpha', 'beta']);
  });

  test('separate handler instances need no shared restart/session state', async () => {
    const firstInstance = handlerWith({});
    const replacementInstance = handlerWith({});

    expect((await firstInstance(initRequest())).headers.get('mcp-session-id')).toBeNull();
    expect((await replacementInstance(toolCallRequest('list_notes'))).status).toBe(200);
  });
});

describe("sessionMode: 'stateful' preserves session continuity", () => {
  test('unknown session ids fail and server-issued ids remain reusable', async () => {
    const handler = handlerWith({ sessionMode: 'stateful' });
    const unknown = await handler(initRequest({ 'mcp-session-id': 'unknown' }));
    expect(unknown.status).toBe(404);

    const first = await handler(initRequest());
    const issued = first.headers.get('mcp-session-id');
    if (!issued) throw new Error('expected a session id');
    const next = await handler(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': issued,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      }),
    );
    expect(next.status).toBe(200);
  });
});
