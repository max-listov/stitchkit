import { expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { AppError, isStitchErrorCode, STITCH_ERROR_STATUS } from '../src/contract/errors';
import { normalizeError } from '../src/contract/normalize';
import { createCli, createCliInvoker, defineCliCommand } from '../src/entrypoints/cli';
import {
  ConnectionAuthorizationRequiredError,
  ConnectionBudgetExceededError,
  ConnectionRequestError,
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
  ConnectionUrlError,
  defineMcpClientConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { cliExitCode } from '../src/tools/cli/format';
import {
  type ToolFailure,
  toolCauseFromResult,
  toolErrorFromResult,
  toolResultFromError,
} from '../src/tools/execute-result';
import { mcpFixture } from './connections-fixture';

const secret = 'private-url-token-body-stack-marker';
const operation = {
  operation: 'tools/call',
  phase: 'call',
  observedReadBytes: 101,
} satisfies {
  operation: 'tools/call';
  phase: 'call';
  observedReadBytes: number;
};

test('expected connection failures have safe codes, registry statuses and serialized exit classes', () => {
  const failures = [
    {
      error: new ConnectionTimeoutError(secret, 20, operation),
      code: 'CONNECTION_TIMEOUT',
      status: 504,
      exit: 7,
      retryable: false,
    },
    {
      error: new ConnectionResponseTooLargeError(secret, 100, operation),
      code: 'CONNECTION_RESPONSE_TOO_LARGE',
      status: 413,
      exit: 1,
      retryable: false,
    },
    {
      error: new ConnectionAuthorizationRequiredError(secret, secret, operation),
      code: 'UNAUTHORIZED',
      status: 401,
      exit: 2,
      retryable: false,
    },
    {
      error: new ConnectionRequestError(secret, 403, secret, operation),
      code: 'FORBIDDEN',
      status: 403,
      exit: 3,
      retryable: false,
    },
    {
      error: new ConnectionRequestError(secret, 503, secret, operation),
      code: 'CONNECTION_REQUEST_FAILED',
      status: 502,
      exit: 1,
      retryable: true,
    },
    {
      error: new ConnectionRequestError(secret, 500, secret, operation),
      code: 'CONNECTION_REQUEST_FAILED',
      status: 502,
      exit: 1,
      retryable: false,
    },
    {
      error: new ConnectionUrlError(secret, `https://example.invalid/?token=${secret}`),
      code: 'BAD_REQUEST',
      status: 400,
      exit: 1,
      retryable: false,
    },
    {
      error: new ConnectionBudgetExceededError(1, 2, secret),
      code: 'BAD_REQUEST',
      status: 400,
      exit: 1,
      retryable: false,
    },
  ];
  const logger = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    for (const { error, code, status, exit, retryable } of failures) {
      const failure = toolResultFromError(error);
      expect(failure).toMatchObject({ ok: false, code, retryable });
      expect(toolCauseFromResult(failure)).toBe(error);
      expect(toolErrorFromResult(failure).status).toBe(status);
      const copied: ToolFailure = { ...failure };
      expect(toolErrorFromResult(copied).status).toBe(status);
      expect(cliExitCode(copied)).toBe(exit);
      expect(isStitchErrorCode(code)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain('stack');
    }
    expect(logger).not.toHaveBeenCalled();
    expect(STITCH_ERROR_STATUS.UPSTREAM_TOOL_ERROR).toBe(502);
    expect(toolErrorFromResult({ ok: false, code: 'UPSTREAM_TOOL_ERROR' }).status).toBe(502);
  } finally {
    logger.mockRestore();
  }
});

test('mounted expected failures are quiet on the invoker and CLI JSON/text paths', async () => {
  let status = 200;
  const fixture = mcpFixture({
    reply: (message) =>
      message.method === 'tools/call' && status !== 200 ? { status, raw: secret } : {},
  });
  const definitions = await mountConnections([
    defineMcpClientConnection({
      name: secret,
      transport: { url: fixture.url.href },
      token: () => secret,
      transports: ['CLI'],
    }),
  ]);
  const raw: unknown[] = [];
  const after: unknown[] = [];
  const hooks = {
    onToolError: ({ error }: { error: unknown }) => {
      raw.push(error);
    },
    afterToolCall: ({ error }: { error?: unknown }) => {
      after.push(error);
    },
  };
  const invoker = await createCliInvoker({ name: 'safe', runtimeTools: definitions, hooks });
  const logger = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    for (const refusal of [
      { status: 401, code: 'UNAUTHORIZED', exit: 2 },
      { status: 403, code: 'FORBIDDEN', exit: 3 },
      { status: 503, code: 'CONNECTION_REQUEST_FAILED', exit: 1 },
    ]) {
      status = refusal.status;
      expect(await invoker.invoke('echo', {})).toMatchObject({
        ok: false,
        exitCode: refusal.exit,
        error: { code: refusal.code },
      });
      for (const compact of [false, true]) {
        let out = '';
        let err = '';
        let exit = -1;
        await createCli({
          name: 'safe',
          version: '1',
          runtimeTools: definitions,
          hooks,
          argv: compact ? ['echo', '--json'] : ['echo'],
          stdout: (text) => {
            out += text;
          },
          stderr: (text) => {
            err += text;
          },
          exit: (value) => {
            exit = value;
          },
          stdin: async () => null,
        });
        expect(exit).toBe(refusal.exit);
        expect(out).toBe('');
        expect(JSON.parse(err)).toMatchObject({ error: refusal.code });
        expect(err).not.toContain(secret);
        expect(err).not.toContain('unhandled error');
        expect(err).not.toContain('stack');
      }
    }
    expect(raw).toHaveLength(9);
    expect(after).toHaveLength(9);
    for (const [index, error] of raw.entries()) expect(after[index]).toBe(error);
    expect(raw[0]).toBeInstanceOf(ConnectionAuthorizationRequiredError);
    expect(raw[3]).toBeInstanceOf(ConnectionRequestError);
    const upstream = raw[6];
    if (!(upstream instanceof ConnectionRequestError))
      throw new Error('Missing request cause');
    expect(upstream.body).toBe(secret);
    expect(logger).not.toHaveBeenCalled();
  } finally {
    logger.mockRestore();
  }
  expect(fixture.seen).not.toContain('GET');
});

test('unknown tool errors scrub console and public output while observers keep exact raw cause', async () => {
  const cause = new Error('private lower-level marker');
  const thrown = new Error(secret, { cause });
  const command = defineCliCommand({
    name: 'unknown',
    description: 'unknown',
    input: z.object({}),
    output: z.unknown(),
    handler: () => {
      throw thrown;
    },
  });
  const errors: unknown[] = [];
  const logger = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = toolResultFromError(thrown);
    expect(toolCauseFromResult(result)).toBe(thrown);
    expect(result).toEqual({
      ok: false,
      code: 'INTERNAL_SERVER_ERROR',
      details: { message: 'Internal server error' },
      retryable: false,
    });
    const invoker = await createCliInvoker({ name: 'safe', commands: [command] });
    expect(await invoker.invoke('unknown', {})).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
    let err = '';
    await createCli({
      name: 'safe',
      version: '1',
      commands: [command],
      argv: ['unknown', '--json'],
      stdout: () => undefined,
      stderr: (text) => {
        err += text;
      },
      exit: () => undefined,
      stdin: async () => null,
    });
    expect(JSON.parse(err)).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    expect(err).not.toContain(secret);
    expect(logger).not.toHaveBeenCalled();
    let fail = false;
    const fixture = mcpFixture();
    const definitions = await mountConnections([
      defineMcpClientConnection({
        name: 'unknown',
        transport: { url: fixture.url.href },
        transports: ['CLI'],
        token: () => {
          if (fail) throw thrown;
          return undefined;
        },
      }),
    ]);
    fail = true;
    const managed = await createCliInvoker({
      name: 'safe',
      runtimeTools: definitions,
      hooks: {
        onToolError: ({ error }) => {
          errors.push(error);
        },
        afterToolCall: ({ error }) => {
          errors.push(error);
        },
      },
    });
    const failed = await managed.invoke('echo', {});
    expect(failed.error?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(errors).toEqual([thrown, thrown]);
    expect(errors[0]).toBe(thrown);
    expect(thrown.cause).toBe(cause);
    expect(logger).not.toHaveBeenCalled();
    // HTTP's default normalization still records the original unexpected failure.
    expect(normalizeError(thrown)).toBeInstanceOf(AppError);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith('[stitchkit] unhandled error:', thrown);
  } finally {
    logger.mockRestore();
  }
});

test('remote isError envelopes retain code, details, hint and declared retryability', async () => {
  const fixture = mcpFixture({
    reply: (message) =>
      message.method === 'tools/call'
        ? {
            result: {
              isError: true,
              content: [],
              structuredContent: {
                error: 'REMOTE_CONFLICT',
                retryable: false,
                details: { message: 'Remote conflict', expected: 2 },
                _hint: 'Reconcile the remote state.',
              },
            },
          }
        : {},
  });
  const definitions = await mountConnections([
    defineMcpClientConnection({
      name: 'remote',
      transport: { url: fixture.url.href },
      transports: ['CLI'],
    }),
  ]);
  expect(
    await (
      await createCliInvoker({
        name: 'safe',
        runtimeTools: definitions,
        exitCodes: { REMOTE_CONFLICT: 42 },
      })
    ).invoke('echo', {}),
  ).toMatchObject({
    ok: false,
    exitCode: 42,
    error: {
      code: 'REMOTE_CONFLICT',
      retryable: false,
      details: { message: 'Remote conflict', expected: 2 },
      hint: 'Reconcile the remote state.',
    },
  });
});
