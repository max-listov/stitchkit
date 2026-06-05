import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError } from '../src/contract';
import type { MethodDef } from '../src/server/types';
import { executeToolMethod, type ToolCallHooks, type ToolResult } from '../src/tools/execute';

function makeMethod(
  overrides: Partial<MethodDef<unknown, unknown, unknown>> = {},
): MethodDef<unknown, unknown, unknown> {
  return {
    method: 'POST',
    path: '/',
    serviceName: 'test',
    key: 'test',
    desc: 'test',
    handler: () => ({ ok: true }),
    ...overrides,
  };
}

describe('executeToolMethod', () => {
  test('success — returns ok result', async () => {
    const method = makeMethod({
      handler: () => ({ users: ['Alice'] }),
    });
    const result = await executeToolMethod(method, 'test_tool', {}, { source: 'mcp' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ users: ['Alice'] });
  });

  test('null/undefined handler → { status: ok }', async () => {
    const method = makeMethod({ handler: () => undefined });
    const result = await executeToolMethod(method, 'test', {}, { source: 'agent' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ status: 'ok' });
  });

  test('validates params', async () => {
    const method = makeMethod({
      paramsSchema: z.object({ id: z.string() }),
      handler: (ctx) => ({ id: ctx.params }),
    });

    const result = await executeToolMethod(method, 'test', { id: 123 }, { source: 'mcp' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect((result.details as Record<string, string>).message).toContain('params');
    }
  });

  test('validates input', async () => {
    const method = makeMethod({
      inputSchema: z.object({ name: z.string() }),
      handler: () => 'ok',
    });

    const result = await executeToolMethod(method, 'test', { name: 42 }, { source: 'mcp' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect((result.details as Record<string, string>).message).toContain('input');
    }
  });

  test('parses params + input from flat args', async () => {
    const method = makeMethod({
      paramsSchema: z.object({ id: z.string() }),
      inputSchema: z.object({ name: z.string() }),
      handler: (ctx) => ({ id: ctx.params, name: ctx.input }),
    });

    const result = await executeToolMethod(
      method,
      'test',
      { id: 'abc', name: 'Max' },
      { source: 'agent' },
    );
    expect(result.ok).toBe(true);
  });

  test('handler AppError → structured error', async () => {
    const method = makeMethod({
      handler: () => {
        throw new AppError('NOT_FOUND', 'User not found', 404, undefined, 'Try list endpoint');
      },
    });

    const result = await executeToolMethod(method, 'test', {}, { source: 'mcp' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.hint).toBe('Try list endpoint');
    }
  });

  test('handler generic error → INTERNAL_SERVER_ERROR', async () => {
    const method = makeMethod({
      handler: () => {
        throw new Error('DB connection failed');
      },
    });

    const result = await executeToolMethod(method, 'test', {}, { source: 'mcp' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('passes context fields to handler', async () => {
    let captured: Record<string, unknown> = {};
    const method = makeMethod({
      handler: (ctx) => {
        captured = { ...ctx };
        return 'ok';
      },
    });

    await executeToolMethod(
      method,
      'test',
      {},
      {
        source: 'agent',
        userId: 'user-1',
        projectId: 'proj-1',
      },
    );

    expect(captured.source).toBe('agent');
    expect(captured.userId).toBe('user-1');
    expect(captured.projectId).toBe('proj-1');
  });

  test('hooks — beforeToolCall + afterToolCall', async () => {
    const calls: string[] = [];
    const hooks: ToolCallHooks = {
      beforeToolCall: (name) => {
        calls.push(`before:${name}`);
      },
      afterToolCall: (name, _args, result, ms) => {
        calls.push(`after:${name}:${result.ok}`);
        expect(ms).toBeGreaterThanOrEqual(0);
      },
    };

    const method = makeMethod({ handler: () => 'data' });
    await executeToolMethod(method, 'my_tool', {}, { source: 'mcp' }, hooks);

    expect(calls).toEqual(['before:my_tool', 'after:my_tool:true']);
  });

  test('beforeToolCall / afterToolCall receive the MethodDef (identity)', async () => {
    let before: MethodDef | undefined;
    let after: MethodDef | undefined;
    const hooks: ToolCallHooks = {
      beforeToolCall: (_n, _a, _ctx, endpoint) => {
        before = endpoint;
      },
      afterToolCall: (_n, _a, _r, _ms, _ctx, endpoint) => {
        after = endpoint;
      },
    };

    const method = makeMethod({ handler: () => 'data' });
    await executeToolMethod(method, 'my_tool', {}, { source: 'mcp' }, hooks);

    // Same MethodDef the HTTP path's afterHandle gets — no toolName→identity map.
    expect(before?.serviceName).toBe('test');
    expect(after?.key).toBe('test');
    expect(after?.method).toBe('POST');
  });

  test('hooks called even on validation error', async () => {
    const afterResults: ToolResult[] = [];
    const hooks: ToolCallHooks = {
      afterToolCall: (_name, _args, result) => {
        afterResults.push(result);
      },
    };

    const method = makeMethod({
      paramsSchema: z.object({ id: z.string() }),
      handler: () => 'ok',
    });

    await executeToolMethod(method, 'test', { id: 123 }, { source: 'mcp' }, hooks);
    expect(afterResults.length).toBe(1);
    expect(afterResults[0]?.ok).toBe(false);
  });

  test('slices flat args — strict params + input schemas work', async () => {
    const method = makeMethod({
      paramsSchema: z.strictObject({ id: z.string() }),
      inputSchema: z.strictObject({ name: z.string() }),
      handler: (ctx) => ({ params: ctx.params, input: ctx.input }),
    });

    const result = await executeToolMethod(
      method,
      'test',
      { id: 'a', name: 'Max' },
      { source: 'mcp' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ params: { id: 'a' }, input: { name: 'Max' } });
    }
  });

  test('validates handler output — a mismatch is a server fault', async () => {
    const method = makeMethod({
      outputSchema: z.object({ id: z.string() }),
      handler: () => ({ id: 123 }),
    });
    const result = await executeToolMethod(method, 'test', {}, { source: 'mcp' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('valid handler output passes outputSchema', async () => {
    const method = makeMethod({
      outputSchema: z.object({ id: z.string() }),
      handler: () => ({ id: 'ok' }),
    });
    const result = await executeToolMethod(method, 'test', {}, { source: 'mcp' });
    expect(result.ok).toBe(true);
  });

  test('lifecycle.beforeHandle can reject the call before the handler', async () => {
    let handlerRan = false;
    const method = makeMethod({
      handler: () => {
        handlerRan = true;
        return 'ok';
      },
    });
    const result = await executeToolMethod(method, 'test', {}, { source: 'mcp' }, undefined, {
      beforeHandle: () => {
        throw new AppError('FORBIDDEN', 'denied', 403);
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FORBIDDEN');
    expect(handlerRan).toBe(false);
  });

  test('lifecycle.afterHandle transforms the result', async () => {
    const method = makeMethod({ handler: () => ({ n: 1 }) });
    const result = await executeToolMethod(method, 'test', {}, { source: 'mcp' }, undefined, {
      afterHandle: (_ctx, data) => ({
        ...(data as Record<string, unknown>),
        wrapped: true,
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ n: 1, wrapped: true });
  });

  test('context cannot shadow params / input / source', async () => {
    let captured: Record<string, unknown> = {};
    const method = makeMethod({
      paramsSchema: z.object({ id: z.string() }),
      handler: (ctx) => {
        captured = { ...ctx };
        return 'ok';
      },
    });
    await executeToolMethod(
      method,
      'test',
      { id: 'real' },
      {
        source: 'agent',
        params: 'HIJACK',
        input: 'HIJACK',
      },
    );
    expect(captured.params).toEqual({ id: 'real' });
    expect(captured.source).toBe('agent');
  });
});
