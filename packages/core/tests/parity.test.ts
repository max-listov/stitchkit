/**
 * Cross-surface parity — the same contract args run through HTTP
 * (`createHandler`), a tool call and the CLI transport (`executeToolMethod`
 * with `source: 'cli'`) must produce the same accept / reject outcome. The
 * mechanical guard behind ADR 0014.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, withToolView } from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';
import { executeToolMethod } from '../src/tools/execute';

const contract = defineContract(
  { prefix: 'parity', scope: 'public' },
  {
    process: {
      method: 'POST',
      path: '/process/:id',
      desc: 'Process a thing',
      params: z.strictObject({ id: z.string() }),
      input: z.strictObject({ count: z.number() }),
      output: z.object({ total: z.number() }),
    },
    badOutput: {
      method: 'POST',
      path: '/bad',
      desc: 'Handler returns a value the contract output rejects',
      output: z.object({ total: z.number().positive() }),
    },
  },
);

const service = implement(contract, {
  process: (ctx) => ({ total: ctx.input.count }),
  // `-5` is a `number` (compiles), but `.positive()` rejects it at runtime —
  // simulates a handler returning the wrong shape.
  badOutput: () => ({ total: -5 }),
});

const handler = createHandler({ services: [service] });

/** Run a contract endpoint over HTTP — returns the outcome shape. */
async function httpCall(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; code: string | null }> {
  const res = await handler(
    new Request(`http://localhost/parity${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  if (res.status >= 200 && res.status < 300) return { ok: true, code: null };
  const json = await res.json();
  return { ok: false, code: json?.error?.code ?? null };
}

/** Run the same endpoint as a tool — returns the outcome shape. */
async function toolCall(
  methodKey: 'process' | 'badOutput',
  args: Record<string, unknown>,
): Promise<{ ok: boolean; code: string | null }> {
  const method = service.methods[methodKey];
  if (!method) throw new Error(`no method ${methodKey}`);
  const result = await executeToolMethod(method, {
    toolName: methodKey,
    rawArgs: args,
    context: { source: 'mcp' },
  });
  return result.ok ? { ok: true, code: null } : { ok: false, code: result.code };
}

/** Run the same endpoint through the CLI transport — returns the outcome shape. */
async function cliCall(
  methodKey: 'process' | 'badOutput',
  args: Record<string, unknown>,
): Promise<{ ok: boolean; code: string | null }> {
  const method = service.methods[methodKey];
  if (!method) throw new Error(`no method ${methodKey}`);
  const result = await executeToolMethod(method, {
    toolName: methodKey,
    rawArgs: args,
    context: { source: 'cli' },
  });
  return result.ok ? { ok: true, code: null } : { ok: false, code: result.code };
}

describe('cross-surface parity (HTTP ≡ tool ≡ CLI)', () => {
  test('valid args — all accept', async () => {
    const http = await httpCall('/process/abc', { count: 5 });
    const tool = await toolCall('process', { id: 'abc', count: 5 });
    const cli = await cliCall('process', { id: 'abc', count: 5 });
    expect(http.ok).toBe(true);
    expect(tool.ok).toBe(true);
    expect(cli.ok).toBe(true);
  });

  test('invalid input type — all reject VALIDATION_ERROR', async () => {
    const http = await httpCall('/process/abc', { count: 'not-a-number' });
    const tool = await toolCall('process', { id: 'abc', count: 'not-a-number' });
    const cli = await cliCall('process', { id: 'abc', count: 'not-a-number' });
    expect(http.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(cli.ok).toBe(false);
    expect(http.code).toBe('VALIDATION_ERROR');
    expect(tool.code).toBe('VALIDATION_ERROR');
    expect(cli.code).toBe('VALIDATION_ERROR');
  });

  test('strict schema — an extra key is rejected on all', async () => {
    const http = await httpCall('/process/abc', { count: 5, extra: 'nope' });
    const tool = await toolCall('process', { id: 'abc', count: 5, extra: 'nope' });
    const cli = await cliCall('process', { id: 'abc', count: 5, extra: 'nope' });
    expect(http.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(cli.ok).toBe(false);
    expect(http.code).toBe('VALIDATION_ERROR');
    expect(tool.code).toBe('VALIDATION_ERROR');
    expect(cli.code).toBe('VALIDATION_ERROR');
  });

  test('output mismatch — all fail INTERNAL_SERVER_ERROR (server fault)', async () => {
    const http = await httpCall('/bad', {});
    const tool = await toolCall('badOutput', {});
    const cli = await cliCall('badOutput', {});
    expect(http.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(cli.ok).toBe(false);
    expect(http.code).toBe('INTERNAL_SERVER_ERROR');
    expect(tool.code).toBe('INTERNAL_SERVER_ERROR');
    expect(cli.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

/**
 * The one declared divergence of the answer (ADR 0196): an endpoint with a
 * `tool.view` answers the tool surface with the view. Acceptance is untouched —
 * the same arguments are accepted or refused on every surface, because the view
 * adds input defaults and never input keys.
 */
const viewed = defineContract(
  { prefix: 'viewed', scope: 'public' },
  {
    read: withToolView(
      {
        method: 'POST',
        path: '/read',
        desc: 'Read with a view',
        input: z.strictObject({ detail: z.boolean().default(true) }),
        output: z.object({ id: z.string(), secret: z.string().optional() }),
      },
      { defaults: { detail: false }, output: z.object({ id: z.string() }) },
    ),
  },
);
const viewedService = implement(viewed, {
  read: (ctx) => ({ id: 'r1', ...(ctx.input.detail && { secret: 's' }) }),
});
const viewedHandler = createHandler({ services: [viewedService] });

async function viewedHttp(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await viewedHandler(
    new Request('http://localhost/viewed/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

async function viewedTool(args: Record<string, unknown>) {
  const method = viewedService.methods.read;
  if (!method) throw new Error('no method read');
  return executeToolMethod(
    method,
    { toolName: 'viewed_read', rawArgs: args, context: { source: 'mcp' } },
    { toolSurface: true },
  );
}

describe('a tool view is the declared divergence, not a parity gap', () => {
  test('the answer differs only by the declaration', async () => {
    expect(await viewedHttp({})).toEqual({ status: 200, json: { id: 'r1', secret: 's' } });
    expect(await viewedTool({})).toEqual({ ok: true, data: { id: 'r1' } });
    // With the detail loaded the full answer carries the secret, and the view
    // still does not: the slice, not the default, is what removes it.
    expect(await viewedTool({ detail: true })).toEqual({ ok: true, data: { id: 'r1' } });
  });

  test('the same arguments are refused on both surfaces', async () => {
    const http = await viewedHttp({ detail: 'yes' });
    const tool = await viewedTool({ detail: 'yes' });
    expect(http.status).toBe(400);
    expect(tool.ok).toBe(false);
    expect(tool.ok ? null : tool.code).toBe('VALIDATION_ERROR');
    const extraHttp = await viewedHttp({ extra: 1 });
    const extraTool = await viewedTool({ extra: 1 });
    expect(extraHttp.status).toBe(400);
    expect(extraTool.ok).toBe(false);
  });
});
