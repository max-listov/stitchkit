import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

    const agent = await executable(mountAgent([service]), 'quota_check')(
      {},
      { toolCallId: 'quota', messages: [], context: undefined },
    );
    expect(agent).toEqual({
      error: 'QUOTA_EXCEEDED',
      details: { retryAfterSeconds: 30 },
      _hint: 'Wait for the current window to expire',
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
