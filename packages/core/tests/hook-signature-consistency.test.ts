/**
 * Two callbacks that could not see what the framework already held:
 * `createErrorHook` dropped the `RuntimeContext` (so a ready-made envelope could
 * not carry a trace id), and `nativeTools` was the only `McpServerBuildConfig`
 * callback of three not given the resolved identity.
 */

import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppError, type RuntimeContext } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import { createErrorHook } from '../src/server/error-hook';
import { buildMcpServer } from '../src/tools/mcp';

/** A RuntimeContext carrying the fields an envelope wants. */
function ctxWith(traceId: string): RuntimeContext {
  return { params: undefined, input: undefined, source: 'http', traceId };
}

describe('createErrorHook — ctx reaches render and onError', () => {
  test('the envelope can carry a trace id without hand-rolling onError', async () => {
    const hook = createErrorHook({
      render: (info, ctx) => ({ ok: false, code: info.code, traceId: ctx.traceId }),
    });
    const res = await hook(ctxWith('trace-1'), new AppError('NOT_FOUND', 'gone', 404));
    expect(res?.status).toBe(404);
    const body: unknown = await res?.json();
    expect(body).toEqual({ ok: false, code: 'NOT_FOUND', traceId: 'trace-1' });
  });

  test('onError observes the same ctx', async () => {
    let seen: string | undefined;
    const hook = createErrorHook({
      render: (info) => ({ code: info.code }),
      onError: (_err, _info, ctx) => {
        seen = typeof ctx.traceId === 'string' ? ctx.traceId : undefined;
      },
    });
    await hook(ctxWith('trace-2'), new Error('boom'));
    expect(seen).toBe('trace-2');
  });

  test('a one-argument render still works — the parameter is additive', async () => {
    // Existing consumers declared `render: (info) => …`; a function with fewer
    // parameters stays assignable, and must keep behaving.
    const hook = createErrorHook({ render: (info) => ({ code: info.code }) });
    const res = await hook(ctxWith('trace-3'), new AppError('FORBIDDEN', 'no', 403));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ code: 'FORBIDDEN' });
  });
});

describe('nativeTools receives the resolved auth', () => {
  test('the same identity that services and context get', async () => {
    const seen: unknown[] = [];
    const server = buildMcpServer<{ tenantId: string }>(
      {
        serverInfo: { name: 't', version: '1' },
        services: (auth) => {
          seen.push(auth);
          return [];
        },
        context: (auth) => {
          seen.push(auth);
          return {};
        },
        nativeTools: (mcp: McpServer, auth) => {
          seen.push(auth);
          mcp.registerTool(
            'whoami',
            { description: 'Who am I', inputSchema: {} },
            async () => ({ content: [{ type: 'text', text: auth.tenantId }] }),
          );
        },
      },
      { tenantId: 'acme' },
    );

    expect(seen).toEqual([{ tenantId: 'acme' }, { tenantId: 'acme' }, { tenantId: 'acme' }]);

    // …and the identity actually reaches the tool's output.
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: 'whoami', arguments: {} });
    const block = isRecord(res) && Array.isArray(res.content) ? res.content[0] : undefined;
    expect(isRecord(block) ? block.text : undefined).toBe('acme');
    await client.close();
  });

  test('a one-parameter nativeTools still compiles and runs', () => {
    let called = false;
    buildMcpServer<{ tenantId: string }>(
      {
        serverInfo: { name: 't', version: '1' },
        services: [],
        nativeTools: () => {
          called = true;
        },
      },
      { tenantId: 'acme' },
    );
    expect(called).toBe(true);
  });
});

describe('the zod peer stays untouched', () => {
  test('a schema still drives a native tool', () => {
    expect(z.object({ a: z.string() }).safeParse({ a: 'x' }).success).toBe(true);
  });
});
