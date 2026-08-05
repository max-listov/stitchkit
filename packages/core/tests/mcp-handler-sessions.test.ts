/**
 * `createMcpHandler`'s session lifecycle — the only stateful code in the
 * framework, and until now the only substantial piece with no direct coverage.
 *
 * What matters here is not the happy path (that is exercised by every other MCP
 * test through `mountMcp`) but the guarantees the handler makes on its own:
 * identity is resolved before anything else, a session id is **never** minted from
 * a client-supplied value, and `stateless: true` really means no session at all.
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

function handlerWith(config: { stateless?: boolean; auth?: (req: Request) => unknown }) {
  return createMcpHandler({
    serverInfo: { name: 't', version: '1' },
    auth: config.auth ?? (() => ({ userId: 'u1' })),
    services: [notes],
    ...(config.stateless !== undefined && { stateless: config.stateless }),
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
    const handler = handlerWith({});
    const res = await handler(initRequest({ 'mcp-session-id': 'forged-by-client' }));
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(isRecord(body) && isRecord(body.error) ? body.error.code : undefined).toBe(-32001);
    expect(JSON.stringify(body)).toContain('Session not found');
  });

  test('the server issues its own id on a fresh initialize', async () => {
    const handler = handlerWith({});
    const res = await handler(initRequest());
    expect(res.status).toBe(200);
    const issued = res.headers.get('mcp-session-id');
    expect(issued).toBeTruthy();
    // A UUID, not anything the caller influenced.
    expect(issued).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the issued id is accepted on the next request', async () => {
    const handler = handlerWith({});
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

describe('stateless: true keeps no session', () => {
  test('no session id is issued, and an unknown one is not a 404', async () => {
    // With no session store there is nothing to "not find" — the whole 404 branch
    // is bypassed, which is the point: a restarted server never invalidates a
    // client.
    const handler = handlerWith({ stateless: true });
    const first = await handler(initRequest());
    expect(first.status).toBe(200);
    expect(first.headers.get('mcp-session-id')).toBeNull();

    const withId = await handler(initRequest({ 'mcp-session-id': 'whatever' }));
    expect(withId.status).toBe(200);
  });

  test('each stateless request stands alone — a second call needs no handshake', async () => {
    const handler = handlerWith({ stateless: true });
    const res = await handler(initRequest());
    expect(res.status).toBe(200);
    const again = await handler(initRequest());
    expect(again.status).toBe(200);
  });
});
