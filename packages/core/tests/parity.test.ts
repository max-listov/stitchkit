/**
 * Cross-surface parity — the same contract args run through HTTP
 * (`createHandler`) and through a tool call (`executeToolMethod`) must produce
 * the same accept / reject outcome. The mechanical guard behind ADR 0014.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createHandler, implement } from '../src/server';
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
  const result = await executeToolMethod(method, methodKey, args, { source: 'mcp' });
  return result.ok ? { ok: true, code: null } : { ok: false, code: result.code };
}

describe('cross-surface parity (HTTP ≡ tool)', () => {
  test('valid args — both accept', async () => {
    const http = await httpCall('/process/abc', { count: 5 });
    const tool = await toolCall('process', { id: 'abc', count: 5 });
    expect(http.ok).toBe(true);
    expect(tool.ok).toBe(true);
  });

  test('invalid input type — both reject VALIDATION_ERROR', async () => {
    const http = await httpCall('/process/abc', { count: 'not-a-number' });
    const tool = await toolCall('process', { id: 'abc', count: 'not-a-number' });
    expect(http.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(http.code).toBe('VALIDATION_ERROR');
    expect(tool.code).toBe('VALIDATION_ERROR');
  });

  test('strict schema — an extra key is rejected on both', async () => {
    const http = await httpCall('/process/abc', { count: 5, extra: 'nope' });
    const tool = await toolCall('process', { id: 'abc', count: 5, extra: 'nope' });
    expect(http.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(http.code).toBe('VALIDATION_ERROR');
    expect(tool.code).toBe('VALIDATION_ERROR');
  });

  test('output mismatch — both fail INTERNAL_SERVER_ERROR (server fault)', async () => {
    const http = await httpCall('/bad', {});
    const tool = await toolCall('badOutput', {});
    expect(http.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(http.code).toBe('INTERNAL_SERVER_ERROR');
    expect(tool.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
