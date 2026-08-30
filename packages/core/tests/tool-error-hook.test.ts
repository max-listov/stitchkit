/**
 * `ToolCallHooks.onToolError` — the raw thrown value behind a failed tool call.
 *
 * The point of the hook is what `afterToolCall` cannot give: an error that is
 * not an `AppError` is scrubbed by `normalizeError` to a bare
 * `INTERNAL_SERVER_ERROR` with no details, so the result the audit hook sees
 * carries nothing about the cause. These tests pin the value as *thrown* —
 * identity, stack and `cause` — and pin the boundary of when it fires.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError } from '../src/contract';
import type { MethodDef, OperationIdentity } from '../src/server/types';
import { mountAgent } from '../src/tools/agent';
import { executeToolMethod, type ToolCallHooks, type ToolResult } from '../src/tools/execute';

function makeMethod(
  overrides: Partial<MethodDef<unknown, unknown, unknown>> = {},
): MethodDef<unknown, unknown, unknown> {
  return {
    method: 'POST',
    path: '/',
    serviceName: 'widgets',
    key: 'update',
    desc: 'Update a widget',
    outputSchema: z.unknown(),
    handler: () => ({ ok: true }),
    ...overrides,
  };
}

/** Silence the framework's own `console.error` for an unexpected throw. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

interface Seen {
  toolName: string;
  error: unknown;
  context: Record<string, unknown>;
  endpoint: OperationIdentity;
}

function recorder(): { seen: Seen[]; hooks: ToolCallHooks } {
  const seen: Seen[] = [];
  return {
    seen,
    hooks: {
      onToolError: ({ toolName, error, context, endpoint }) => {
        seen.push({ toolName, error, context, endpoint });
      },
    },
  };
}

describe('onToolError — the value as thrown', () => {
  test('an unexpected throw reaches the hook whole, while the result is scrubbed', async () => {
    const cause = new Error('connection reset');
    const thrown = new Error('db timeout at 10.0.0.4:5432', { cause });
    const method = makeMethod({
      handler: () => {
        throw thrown;
      },
    });
    const { seen, hooks } = recorder();

    const result = await quietly(() =>
      executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks),
    );

    // Same object — not a copy, not a message string.
    expect(seen).toHaveLength(1);
    const captured = seen[0]?.error;
    expect(captured).toBe(thrown);
    expect(captured).toBeInstanceOf(Error);
    if (captured instanceof Error) {
      expect(captured.stack).toContain('db timeout');
      expect(captured.cause).toBe(cause);
    }

    // And this is precisely what the hook exists for: the result says nothing.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INTERNAL_SERVER_ERROR');
      expect(result.details).toEqual({ message: 'Internal server error' });
    }
  });

  test('an AppError arrives as thrown too, not re-normalised', async () => {
    const thrown = new AppError('NOT_FOUND', 'No such widget', 404, { id: 'w1' });
    const method = makeMethod({
      handler: () => {
        throw thrown;
      },
    });
    const { seen, hooks } = recorder();

    await executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks);

    expect(seen[0]?.error).toBe(thrown);
  });

  test('a non-Error throw is passed through unchanged', async () => {
    const method = makeMethod({
      handler: () => {
        throw 'just a string';
      },
    });
    const { seen, hooks } = recorder();

    await quietly(() =>
      executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks),
    );

    expect(seen[0]?.error).toBe('just a string');
  });

  test('carries the tool name, the call context and the endpoint identity', async () => {
    const method = makeMethod({
      handler: () => {
        throw new AppError('FORBIDDEN', 'nope', 403);
      },
    });
    const { seen, hooks } = recorder();

    await executeToolMethod(
      method,
      'update_widget',
      { id: 'w1' },
      { source: 'agent', userId: 'u-7' },
      hooks,
    );

    expect(seen[0]?.toolName).toBe('update_widget');
    expect(seen[0]?.context.source).toBe('agent');
    expect(seen[0]?.context.userId).toBe('u-7');
    expect(seen[0]?.endpoint.serviceName).toBe('widgets');
    expect(seen[0]?.endpoint.key).toBe('update');
  });
});

describe('onToolError — the span it covers', () => {
  test('fires for a throw from lifecycle.beforeHandle', async () => {
    const thrown = new AppError('UNAUTHORIZED', 'no scope', 401);
    const { seen, hooks } = recorder();

    const result = await executeToolMethod(
      makeMethod(),
      'update_widget',
      {},
      { source: 'mcp' },
      hooks,
      {
        beforeHandle: () => {
          throw thrown;
        },
      },
    );

    expect(seen[0]?.error).toBe(thrown);
    expect(result.ok).toBe(false);
  });

  test('fires for a throw from lifecycle.afterHandle', async () => {
    const thrown = new Error('transform blew up');
    const { seen, hooks } = recorder();

    await quietly(() =>
      executeToolMethod(makeMethod(), 'update_widget', {}, { source: 'mcp' }, hooks, {
        afterHandle: () => {
          throw thrown;
        },
      }),
    );

    expect(seen[0]?.error).toBe(thrown);
  });

  test('does not fire for a beforeToolCall rejection — the result already says why', async () => {
    const seen: unknown[] = [];
    const results: ToolResult[] = [];
    const hooks: ToolCallHooks = {
      beforeToolCall: () => {
        throw new AppError('UNAUTHORIZED', 'no scope', 401);
      },
      onToolError: ({ error }) => {
        seen.push(error);
      },
      afterToolCall: ({ result }) => {
        results.push(result);
      },
    };

    await executeToolMethod(makeMethod(), 'update_widget', {}, { source: 'mcp' }, hooks);

    expect(seen).toHaveLength(0);
    expect(results[0]).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
  });

  test('does not fire for an argument-validation failure', async () => {
    const method = makeMethod({ inputSchema: z.object({ name: z.string() }) });
    const { seen, hooks } = recorder();

    const result = await executeToolMethod(
      method,
      'update_widget',
      { name: 42 },
      { source: 'mcp' },
      hooks,
    );

    expect(seen).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
  });

  test('does not fire for an output-schema mismatch', async () => {
    const method = makeMethod({
      outputSchema: z.object({ id: z.string() }),
      handler: () => ({ id: 42 }),
    });
    const { seen, hooks } = recorder();

    const result = await executeToolMethod(
      method,
      'update_widget',
      {},
      { source: 'mcp' },
      hooks,
    );

    expect(seen).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('does not fire on success', async () => {
    const { seen, hooks } = recorder();
    const result = await executeToolMethod(
      makeMethod(),
      'update_widget',
      {},
      { source: 'mcp' },
      hooks,
    );
    expect(seen).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  test('fires exactly once per failed call', async () => {
    const { seen, hooks } = recorder();
    const method = makeMethod({
      handler: () => {
        throw new AppError('CONFLICT', 'clash', 409);
      },
    });

    await executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks);
    await executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks);

    expect(seen).toHaveLength(2);
  });
});

describe('onToolError — it observes, it does not interfere', () => {
  test('runs before afterToolCall, and is awaited', async () => {
    const order: string[] = [];
    const hooks: ToolCallHooks = {
      onToolError: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('onToolError');
      },
      afterToolCall: () => {
        order.push('afterToolCall');
      },
    };
    const method = makeMethod({
      handler: () => {
        throw new AppError('CONFLICT', 'clash', 409);
      },
    });

    await executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks);

    // Ordered, not merely both-fired: a consumer records the cause here and the
    // audit hook reads it in `afterToolCall`.
    expect(order).toEqual(['onToolError', 'afterToolCall']);
  });

  test('the envelope stays the framework its own — the hook cannot shape it', async () => {
    // The `void` return already forbids returning an envelope at compile time
    // (that is why the hook is not an `onError` twin); this pins the runtime
    // half — a hook that runs changes nothing about the result.
    const hooks: ToolCallHooks = {
      onToolError: () => undefined,
    };
    const method = makeMethod({
      handler: () => {
        throw new AppError('NOT_FOUND', 'gone', 404);
      },
    });

    const result = await executeToolMethod(
      method,
      'update_widget',
      {},
      { source: 'mcp' },
      hooks,
    );

    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', details: { message: 'gone' } });
  });

  test('a throwing hook does not replace the failure it was called to observe', async () => {
    const results: ToolResult[] = [];
    const hooks: ToolCallHooks = {
      onToolError: () => {
        throw new Error('the sink is down');
      },
      afterToolCall: ({ result }) => {
        results.push(result);
      },
    };
    const method = makeMethod({
      handler: () => {
        throw new AppError('NOT_FOUND', 'gone', 404);
      },
    });

    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args[0]);
    let result: ToolResult;
    try {
      result = await executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks);
    } finally {
      console.error = original;
    }

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    // The audit trail is intact — a broken sink must not cost the record.
    expect(results[0]).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    // And the hook's own failure is reported rather than swallowed in silence.
    expect(logged).toContain('[stitchkit] onToolError hook failed:');
  });

  test('a rejecting async hook is caught the same way', async () => {
    const hooks: ToolCallHooks = {
      onToolError: () => Promise.reject(new Error('sink timeout')),
    };
    const method = makeMethod({
      handler: () => {
        throw new AppError('NOT_FOUND', 'gone', 404);
      },
    });

    const result = await quietly(() =>
      executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks),
    );

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('onToolError — reaches the real mounts', () => {
  test('mountAgent plumbs the hook through to a throwing handler', async () => {
    const thrown = new Error('handler exploded');
    const { seen, hooks } = recorder();
    const tools = mountAgent(
      {
        name: 'widgets',
        prefix: 'widgets',
        scope: 'widgets',
        methods: {
          update: makeMethod({
            toolName: 'update_widget',
            expose: ['AGENT'],
            handler: () => {
              throw thrown;
            },
          }),
        },
      },
      { hooks },
    );

    const execute = tools.update_widget?.execute;
    if (!execute) throw new Error('expected the update_widget tool');
    await expect(
      quietly(() => execute({}, { toolCallId: 't1', messages: [], context: undefined })),
    ).rejects.toMatchObject({ output: { error: 'INTERNAL_SERVER_ERROR' } });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBe(thrown);
    expect(seen[0]?.context.source).toBe('agent');
  });
});

describe('the raw cause reaches afterToolCall too', () => {
  test('the same value, by identity, alongside the scrubbed result', async () => {
    const thrown = new Error('db timeout');
    const seen: Array<{ result: ToolResult; error: unknown }> = [];
    const hooks: ToolCallHooks = {
      afterToolCall: ({ result, error }) => {
        seen.push({ result, error });
      },
    };
    const method = makeMethod({
      handler: () => {
        throw thrown;
      },
    });

    await quietly(() =>
      executeToolMethod(method, 'update_widget', {}, { source: 'mcp' }, hooks),
    );

    expect(seen[0]?.error).toBe(thrown);
    // The pairing is the point: the envelope says nothing, the cause is beside it.
    expect(seen[0]?.result).toMatchObject({ ok: false, code: 'INTERNAL_SERVER_ERROR' });
  });

  test('undefined when nothing was thrown — success and both non-throw failures', async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const hooks: ToolCallHooks = {
      afterToolCall: ({ error }) => {
        calls += 1;
        seen.push(error);
      },
    };

    // Success.
    await executeToolMethod(makeMethod(), 'w', {}, { source: 'mcp' }, hooks);
    // Argument validation.
    await executeToolMethod(
      makeMethod({ inputSchema: z.object({ name: z.string() }) }),
      'w',
      { name: 42 },
      { source: 'mcp' },
      hooks,
    );
    // Output-schema mismatch.
    await executeToolMethod(
      makeMethod({ outputSchema: z.object({ id: z.string() }), handler: () => ({ id: 1 }) }),
      'w',
      {},
      { source: 'mcp' },
      hooks,
    );
    // `beforeToolCall` rejection.
    await executeToolMethod(
      makeMethod(),
      'w',
      {},
      { source: 'mcp' },
      {
        ...hooks,
        beforeToolCall: () => {
          throw new AppError('UNAUTHORIZED', 'no', 401);
        },
      },
    );

    expect(calls).toBe(4);
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('a hook may destructure only the fields it needs', async () => {
    // Future fields are additive because callbacks accept one object and
    // consumers destructure only the stable vocabulary they use.
    let fired = 0;
    const hooks: ToolCallHooks = {
      afterToolCall: ({ toolName }) => {
        expect(toolName).toBe('w');
        fired += 1;
      },
    };

    await quietly(() =>
      executeToolMethod(
        makeMethod({
          handler: () => {
            throw new Error('boom');
          },
        }),
        'w',
        {},
        { source: 'mcp' },
        hooks,
      ),
    );

    expect(fired).toBe(1);
  });
});
