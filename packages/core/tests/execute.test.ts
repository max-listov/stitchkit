import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError } from '../src/contract';
import type { MethodDef, OperationIdentity } from '../src/server/types';
import {
  type AfterToolCallOptions,
  type BeforeToolCallOptions,
  executeToolMethod,
  type ToolCallHooks,
  type ToolErrorOptions,
  type ToolResult,
} from '../src/tools/execute';

function makeMethod(
  overrides: Partial<MethodDef<unknown, unknown, unknown>> = {},
): MethodDef<unknown, unknown, unknown> {
  return {
    method: 'POST',
    path: '/',
    serviceName: 'test',
    key: 'test',
    desc: 'test',
    outputSchema: z.unknown(),
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

  test('null/undefined no-output handler → { status: ok }', async () => {
    for (const value of [null, undefined]) {
      const method = makeMethod({ outputSchema: undefined, handler: () => value });
      const result = await executeToolMethod(method, 'test', {}, { source: 'agent' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toEqual({ status: 'ok' });
    }
  });

  test('rejects undeclared tool data and undefined declared output', async () => {
    const undeclared = await executeToolMethod(
      makeMethod({ outputSchema: undefined, handler: () => ({ leaked: true }) }),
      'test',
      {},
      { source: 'agent' },
    );
    expect(undeclared).toEqual({
      ok: false,
      code: 'INTERNAL_SERVER_ERROR',
      details: { message: 'Handler returned data but the contract declares no output' },
    });

    const missing = await executeToolMethod(
      makeMethod({ outputSchema: z.unknown(), handler: () => undefined }),
      'test',
      {},
      { source: 'mcp' },
    );
    expect(missing).toEqual({
      ok: false,
      code: 'INTERNAL_SERVER_ERROR',
      details: { message: 'Handler returned undefined but the contract declares an output' },
    });
  });

  test('preserves null when a tool output schema declares it', async () => {
    const result = await executeToolMethod(
      makeMethod({
        outputSchema: z.object({ id: z.string() }).nullable(),
        handler: () => null,
      }),
      'nullable',
      {},
      { source: 'mcp' },
    );
    expect(result).toEqual({ ok: true, data: null });
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

  test('a union with a CONSTRAINED string member is never silently JSON-parsed (MCP path)', async () => {
    // The coercion rule is decided by the union MEMBER, not by whether this
    // value happens to validate. Each value below WOULD validate if parsed
    // (number / object branch) — so a passing call would prove corruption; the
    // only correct outcome is a loud validation failure on the raw string.
    const cases: Array<{ member: z.ZodType; value: string }> = [
      { member: z.uuid(), value: '123' },
      { member: z.email(), value: '123' },
      { member: z.string().min(4), value: '123' },
      { member: z.cuid2(), value: '{"a":"b"}' },
    ];
    for (const { member, value } of cases) {
      const method = makeMethod({
        inputSchema: z.object({
          target: z.union([member, z.number(), z.object({ a: z.string() })]),
        }),
        handler: (ctx) => ctx.input,
      });
      const result = await executeToolMethod(
        method,
        'test',
        { target: value },
        { source: 'mcp' },
        undefined,
        undefined,
        true,
      );
      expect(result.ok).toBe(false);
    }
  });

  test('a string valid for the string member arrives as the string, not a parsed number', async () => {
    let received: unknown;
    const method = makeMethod({
      inputSchema: z.object({ target: z.union([z.string().min(2), z.number()]) }),
      outputSchema: z.unknown(),
      handler: (ctx) => {
        received = (ctx.input as { target: unknown }).target;
        return { ok: true };
      },
    });
    const result = await executeToolMethod(
      method,
      'test',
      { target: '123' },
      { source: 'mcp' },
      undefined,
      undefined,
      true,
    );
    expect(result.ok).toBe(true);
    expect(received).toBe('123');
  });

  test('a union WITHOUT a string member still repairs a double-serialized value (MCP path)', async () => {
    let received: unknown;
    const method = makeMethod({
      inputSchema: z.object({
        target: z.union([z.array(z.string()), z.object({ a: z.string() })]),
      }),
      outputSchema: z.unknown(),
      handler: (ctx) => {
        received = (ctx.input as { target: unknown }).target;
        return { ok: true };
      },
    });
    const result = await executeToolMethod(
      method,
      'test',
      { target: '["a","b"]' },
      { source: 'mcp' },
      undefined,
      undefined,
      true,
    );
    expect(result.ok).toBe(true);
    expect(received).toEqual(['a', 'b']);
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
      beforeToolCall: ({ toolName }) => {
        calls.push(`before:${toolName}`);
      },
      afterToolCall: ({ toolName, result, durationMs }) => {
        calls.push(`after:${toolName}:${result.ok}`);
        expect(durationMs).toBeGreaterThanOrEqual(0);
      },
    };

    const method = makeMethod({ handler: () => 'data' });
    await executeToolMethod(method, 'my_tool', {}, { source: 'mcp' }, hooks);

    expect(calls).toEqual(['before:my_tool', 'after:my_tool:true']);
  });

  test('each hook exposes its named public options type', () => {
    const hooks: ToolCallHooks = {
      beforeToolCall: ({ toolName, args, context, endpoint }: BeforeToolCallOptions) => {
        expect([toolName, args, context, endpoint]).toHaveLength(4);
      },
      afterToolCall: ({
        toolName,
        args,
        result,
        durationMs,
        context,
        endpoint,
        error,
      }: AfterToolCallOptions) => {
        expect([toolName, args, result, durationMs, context, endpoint, error]).toHaveLength(7);
      },
      onToolError: ({ toolName, error, context, endpoint }: ToolErrorOptions) => {
        expect([toolName, error, context, endpoint]).toHaveLength(4);
      },
    };

    expect(hooks).toBeDefined();
  });

  test('beforeToolCall / afterToolCall receive the operation identity', async () => {
    let before: OperationIdentity | undefined;
    let after: OperationIdentity | undefined;
    const hooks: ToolCallHooks = {
      beforeToolCall: ({ endpoint }) => {
        before = endpoint;
      },
      afterToolCall: ({ endpoint }) => {
        after = endpoint;
      },
    };

    const method = makeMethod({ handler: () => 'data' });
    await executeToolMethod(method, 'my_tool', {}, { source: 'mcp' }, hooks);

    // Same stable identity fields as the HTTP MethodDef — no toolName→identity map.
    expect(before?.serviceName).toBe('test');
    expect(after?.key).toBe('test');
    expect(after?.method).toBe('POST');
  });

  test('hooks called even on validation error', async () => {
    const afterResults: ToolResult[] = [];
    const hooks: ToolCallHooks = {
      afterToolCall: ({ result }) => {
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
