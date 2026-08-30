import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError, defineContract, defineErrors } from '../src/contract';
import { createHandler, implement } from '../src/server';
import { buildMcpServer, createToolInvoker, mountAgent } from '../src/tools';

const { errors, codes, definitions, isCode } = defineErrors({
  SESSION_NOT_FOUND: { status: 404 },
  QUOTA_EXCEEDED: {
    status: 429,
    details: z.object({ retryAfterSeconds: z.number().int().positive() }),
  },
  OPTIONAL_CONTEXT: {
    status: 409,
    details: z.object({ reason: z.string() }).optional(),
  },
});

function compileTimeContracts(): void {
  errors.SESSION_NOT_FOUND();
  errors.SESSION_NOT_FOUND({ message: 'gone', hint: 'log in again' });
  errors.QUOTA_EXCEEDED({ details: { retryAfterSeconds: 30 } });
  errors.OPTIONAL_CONTEXT();
  errors.OPTIONAL_CONTEXT({ details: { reason: 'conflict' } });

  // @ts-expect-error — details are forbidden without a schema.
  errors.SESSION_NOT_FOUND({ details: { sessionId: 's1' } });
  // @ts-expect-error — a required details schema makes the options/details required.
  errors.QUOTA_EXCEEDED();
  // @ts-expect-error — per-code details retain their inferred field types.
  errors.QUOTA_EXCEEDED({ details: { retryAfterSeconds: 'later' } });
  // @ts-expect-error — numeric definitions and the positional API are removed.
  defineErrors({ LEGACY_ERROR: 400 });
}
void compileTimeContracts;

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'domain-error-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function executable(tools: ReturnType<typeof mountAgent>, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

function quotaError() {
  return errors.QUOTA_EXCEEDED({
    message: 'Quota exhausted',
    details: { retryAfterSeconds: 30 },
    hint: 'Wait for the current window to expire',
  });
}

describe('defineErrors', () => {
  test('constructs a literal-code AppError with exact typed details', () => {
    const error = quotaError();
    const code: 'QUOTA_EXCEEDED' = error.code;
    const retryAfterSeconds: number = error.details.retryAfterSeconds;

    expect(code).toBe('QUOTA_EXCEEDED');
    expect(retryAfterSeconds).toBe(30);
    expect(error.status).toBe(429);
    expect(error.message).toBe('Quota exhausted');
    expect(error.hint).toBe('Wait for the current window to expire');
    expect(AppError.is(error)).toBe(true);
  });

  test('returns an error instance and leaves throwing to the caller', () => {
    const error = errors.SESSION_NOT_FOUND({ message: 'No such session' });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('SESSION_NOT_FOUND');
    expect(error.status).toBe(404);
  });

  test('runtime-validates required, optional and forbidden details', () => {
    expect(() =>
      errors.QUOTA_EXCEEDED(JSON.parse('{"details":{"retryAfterSeconds":"later"}}')),
    ).toThrow();
    expect(() =>
      errors.SESSION_NOT_FOUND(JSON.parse('{"details":{"sessionId":"s1"}}')),
    ).toThrow('does not declare details');
    expect(errors.OPTIONAL_CONTEXT().details).toBeUndefined();
  });

  test('fails first on invalid statuses and non-object detail schemas', () => {
    expect(() => defineErrors(JSON.parse('{"INVALID":{"status":200}}'))).toThrow(
      'integer HTTP status from 400 to 599',
    );
    expect(() =>
      defineErrors({
        INVALID: {
          status: 400,
          // @ts-expect-error — runtime guard coverage for untyped callers.
          details: z.string(),
        },
      }),
    ).toThrow('details must be a Zod object');
  });

  test('codes, guard and frozen definitions share one exact registry', () => {
    expect(codes.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
    expect(codes.QUOTA_EXCEEDED).toBe('QUOTA_EXCEEDED');
    expect(definitions.QUOTA_EXCEEDED.status).toBe(429);
    expect(definitions.QUOTA_EXCEEDED.details).toBeDefined();
    expect(isCode('SESSION_NOT_FOUND')).toBe(true);
    expect(isCode('SOMETHING_ELSE')).toBe(false);
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(definitions.QUOTA_EXCEEDED)).toBe(true);
    expect(Object.isFrozen(codes)).toBe(true);
  });

  test('serialises the established public envelope', () => {
    expect(quotaError().toJSON()).toEqual({
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'Quota exhausted',
        details: { retryAfterSeconds: 30 },
        hint: 'Wait for the current window to expire',
      },
    });
  });
});

describe('domain error transport normalization', () => {
  const contract = defineContract(
    { prefix: 'limits' },
    {
      check: {
        method: 'POST',
        path: '/check',
        desc: 'Check the current quota',
        toolName: 'quota_check',
        input: z.object({}),
      },
    },
  );
  const service = implement(contract, {
    check: () => {
      throw quotaError();
    },
  });

  test('HTTP preserves code, status, message, details and hint', async () => {
    const handler = createHandler({ services: [service] });
    const response = await handler(
      new Request('http://local/limits/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(quotaError().toJSON());
  });

  test('MCP and Agent keep the canonical model-facing projection', async () => {
    const client = await connect(
      buildMcpServer(
        { serverInfo: { name: 'errors', version: '1' }, services: [service] },
        undefined,
      ),
    );
    const mcp = await client.callTool({ name: 'quota_check', arguments: {} });
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp.content)).toContain('QUOTA_EXCEEDED');
    expect(JSON.stringify(mcp.content)).toContain('retryAfterSeconds');
    expect(JSON.stringify(mcp.content)).toContain('Wait for the current window to expire');
    await client.close();

    await expect(
      executable(mountAgent([service]), 'quota_check')(
        {},
        { toolCallId: 'quota', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({
      output: {
        error: 'QUOTA_EXCEEDED',
        details: { retryAfterSeconds: 30 },
        _hint: 'Wait for the current window to expire',
      },
    });
  });

  test('in-process throwing composition retains the exact AppError', async () => {
    const invoker = createToolInvoker([service], { transport: 'MCP' });
    try {
      await invoker.invokeOrThrow('quota_check', {});
      throw new Error('expected quota error');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      if (!AppError.is(error)) return;
      expect(error.code).toBe('QUOTA_EXCEEDED');
      expect(error.status).toBe(429);
      expect(error.message).toBe('Quota exhausted');
      expect(error.details).toEqual({ retryAfterSeconds: 30 });
      expect(error.hint).toBe('Wait for the current window to expire');
    }
  });
});

describe('defineErrors — declared message', () => {
  const registry = defineErrors({
    SESSION_EXPIRED: { status: 401, message: 'Your session expired' },
    QUOTA_EXCEEDED: {
      status: 429,
      message: 'Monthly quota exhausted',
      details: z.object({ retryAfterSeconds: z.number().int().positive() }),
    },
    PLAIN: { status: 409 },
  });

  test('uses the declared message when the call site gives none', () => {
    expect(registry.errors.SESSION_EXPIRED().message).toBe('Your session expired');
    expect(
      registry.errors.QUOTA_EXCEEDED({ details: { retryAfterSeconds: 30 } }).message,
    ).toBe('Monthly quota exhausted');
  });

  test('a per-call message overrides the declared one', () => {
    expect(registry.errors.SESSION_EXPIRED({ message: 'Signed out' }).message).toBe(
      'Signed out',
    );
  });

  test('a code without a declared message still falls back to the code', () => {
    expect(registry.errors.PLAIN().message).toBe('PLAIN');
  });

  test('the declared message is readable by a union key and by a narrowed string', () => {
    const unionKey: keyof typeof registry.definitions = 'SESSION_EXPIRED';
    const byUnionKey: string | undefined = registry.definitions[unionKey].message;
    expect(byUnionKey).toBe('Your session expired');
    expect(registry.definitions.PLAIN.message).toBeUndefined();

    // The consumer path: a code arriving as a plain string, narrowed by isCode.
    const fromTheWire: string = 'SESSION_EXPIRED';
    if (!registry.isCode(fromTheWire)) throw new Error('expected a declared code');
    const byNarrowedString: string | undefined = registry.definitions[fromTheWire].message;
    expect(byNarrowedString).toBe('Your session expired');
  });

  test('an explicit message: undefined falls through to the declared text', () => {
    expect(registry.errors.SESSION_EXPIRED({ message: undefined }).message).toBe(
      'Your session expired',
    );
  });

  test('a non-string message is rejected with a stitchkit error, not a TypeError', () => {
    expect(() => defineErrors(JSON.parse('{"BAD":{"status":400,"message":42}}'))).toThrow(
      '[stitchkit] Error "BAD" message must be a non-empty string',
    );
    expect(() => defineErrors(JSON.parse('{"BAD":{"status":400,"message":null}}'))).toThrow(
      '[stitchkit] Error "BAD" message must be a non-empty string',
    );
  });

  test('an empty declared message is rejected when the registry is declared', () => {
    expect(() => defineErrors({ BAD: { status: 400, message: '   ' } })).toThrow(
      '[stitchkit] Error "BAD" message must be a non-empty string',
    );
  });

  test('the declared message reaches the HTTP envelope', () => {
    expect(registry.errors.SESSION_EXPIRED().toJSON()).toMatchObject({
      error: { code: 'SESSION_EXPIRED', message: 'Your session expired' },
    });
  });

  test('the model-facing tool projection still carries no message — by design', async () => {
    const contract = defineContract(
      { prefix: 'quota' },
      {
        check: {
          method: 'POST',
          path: '/check',
          desc: 'Check quota',
          toolName: 'quota_message_check',
          input: z.object({}),
        },
      },
    );
    const service = implement(contract, {
      check: () => {
        throw registry.errors.QUOTA_EXCEEDED({ details: { retryAfterSeconds: 30 } });
      },
    });
    // A code WITH a details schema shows the model no text at all: the envelope
    // is `{ error, details?, _hint? }` and its `details` is the parsed payload.
    await expect(
      executable(mountAgent([service]), 'quota_message_check')(
        {},
        { toolCallId: 'quota-message', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({
      output: {
        error: 'QUOTA_EXCEEDED',
        details: { retryAfterSeconds: 30 },
      },
    });
  });

  test('a code without a details schema delivers the declared text as details.message', async () => {
    const contract = defineContract(
      { prefix: 'session' },
      {
        touch: {
          method: 'POST',
          path: '/touch',
          desc: 'Touch the session',
          toolName: 'session_touch',
          input: z.object({}),
        },
      },
    );
    const withMessage = implement(contract, {
      touch: () => {
        throw registry.errors.SESSION_EXPIRED();
      },
    });
    const withoutMessage = implement(contract, {
      touch: () => {
        throw registry.errors.PLAIN();
      },
    });

    // This is the branch the declared message actually changes on the tool path:
    // the framework fills `details` with `{ message }` when a code declares no
    // details schema. It used to be the code itself.
    await expect(
      executable(mountAgent([withMessage]), 'session_touch')(
        {},
        { toolCallId: 'touch-1', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({
      output: {
        error: 'SESSION_EXPIRED',
        details: { message: 'Your session expired' },
      },
    });

    // A code that declares no message is unchanged — `details.message` is the code.
    await expect(
      executable(mountAgent([withoutMessage]), 'session_touch')(
        {},
        { toolCallId: 'touch-2', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({
      output: { error: 'PLAIN', details: { message: 'PLAIN' } },
    });
  });
});
