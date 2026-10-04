import { expect, test } from 'bun:test';
import { createCliInvoker } from '../src/entrypoints/cli';
import {
  ConnectionResponseTooLargeError,
  defineMcpClientConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { McpHttpClient } from '../src/tools/connections/mcp-client';
import type { McpConnectionLimits } from '../src/tools/connections/types';
import { mcpFixture } from './connections-fixture';

const MiB = 1024 * 1024;
async function mounted(url: URL, limits?: McpConnectionLimits) {
  return mountConnections([
    defineMcpClientConnection({
      name: 'phase-fixture',
      transport: { url: url.href },
      transports: ['CLI'],
      ...(limits && { limits }),
    }),
  ]);
}
function client(url: URL, limits?: McpConnectionLimits) {
  return new McpHttpClient('phase-fixture', 'test-instance', {
    transport: { url: url.href },
    allowedHosts: new Set([url.host]),
    timeoutMs: 1000,
    maxResponseBytes: MiB,
    ...(limits && { limits }),
  });
}

test('discovery.maxResponseBytes admits a large catalog while call keeps its default ceiling', async () => {
  let large = true;
  const fixture = mcpFixture({
    tools: [
      { name: 'echo', description: 'x'.repeat(MiB + 1), inputSchema: { type: 'object' } },
    ],
    reply: (message) =>
      message.method === 'tools/call'
        ? {
            result: {
              content: [],
              structuredContent: { value: large ? 'x'.repeat(MiB + 1) : 'ok' },
            },
          }
        : {},
  });
  await expect(mounted(fixture.url)).rejects.toBeInstanceOf(ConnectionResponseTooLargeError);
  const definitions = await mounted(fixture.url, { discovery: { maxResponseBytes: 2 * MiB } });
  let cause: unknown;
  const invoker = await createCliInvoker({
    name: 'phases',
    runtimeTools: definitions,
    hooks: {
      onToolError: ({ error }) => {
        cause = error;
      },
    },
  });
  const refused = await invoker.invoke('echo', {});
  expect(refused.error).toMatchObject({
    code: 'CONNECTION_RESPONSE_TOO_LARGE',
    retryable: false,
    details: { operation: 'tools/call', phase: 'call', maxResponseBytes: MiB },
  });
  expect(cause).toBeInstanceOf(ConnectionResponseTooLargeError);
  if (!(cause instanceof ConnectionResponseTooLargeError))
    throw new Error('Missing size cause');
  expect(cause.observedReadBytes).toBeGreaterThan(MiB);
  expect(Number.isFinite(cause.observedReadBytes)).toBe(true);
  large = false;
  expect(await invoker.invoke('echo', {})).toMatchObject({
    ok: true,
    exitCode: 0,
    data: { value: 'ok' },
  });
});

test('call.maxResponseBytes admits a large call without enlarging discovery', async () => {
  let catalogLarge = false;
  const fixture = mcpFixture({
    reply: (message) =>
      message.method === 'tools/list'
        ? {
            result: {
              tools: [
                {
                  name: 'echo',
                  description: catalogLarge ? 'x'.repeat(MiB + 1) : 'small',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          }
        : message.method === 'tools/call'
          ? { result: { content: [], structuredContent: { value: 'x'.repeat(MiB + 1) } } }
          : {},
  });
  const definitions = await mounted(fixture.url, { call: { maxResponseBytes: 2 * MiB } });
  const result = await (
    await createCliInvoker({ name: 'phases', runtimeTools: definitions })
  ).invoke('echo', {});
  expect(result.ok).toBe(true);
  expect(result.data).toEqual({ value: 'x'.repeat(MiB + 1) });
  catalogLarge = true;
  await expect(
    mounted(fixture.url, { call: { maxResponseBytes: 2 * MiB } }),
  ).rejects.toBeInstanceOf(ConnectionResponseTooLargeError);
});

test('call.timeoutMs admits a slow call and managed-call initialize stays discovery', async () => {
  let hangInitialize = false;
  const fixture = mcpFixture({
    reply: (message) =>
      message.method === 'initialize'
        ? { hold: hangInitialize }
        : message.method === 'tools/call'
          ? { delayMs: 70 }
          : {},
  });
  const definitions = await mounted(fixture.url, {
    discovery: { timeoutMs: 40 },
    call: { timeoutMs: 200 },
  });
  const invoker = await createCliInvoker({ name: 'phases', runtimeTools: definitions });
  expect(await invoker.invoke('echo', {})).toMatchObject({ ok: true });
  const callCount = fixture.seen.filter((method) => method === 'tools/call').length;
  hangInitialize = true;
  expect(await invoker.invoke('echo', {})).toMatchObject({
    ok: false,
    exitCode: 7,
    error: {
      code: 'CONNECTION_TIMEOUT',
      retryable: false,
      details: {
        operation: 'initialize',
        phase: 'discovery',
        timeoutMs: 40,
        observedReadBytes: 0,
      },
    },
  });
  expect(fixture.seen.filter((method) => method === 'tools/call')).toHaveLength(callCount);
});

test('discovery.timeoutMs admits a slow catalog while a slow call keeps its call deadline', async () => {
  const fixture = mcpFixture({
    reply: (message) => ({
      delayMs: message.method === 'tools/list' || message.method === 'tools/call' ? 70 : 0,
    }),
  });
  const definitions = await mounted(fixture.url, {
    discovery: { timeoutMs: 200 },
    call: { timeoutMs: 30 },
  });
  expect(
    await (await createCliInvoker({ name: 'phases', runtimeTools: definitions })).invoke(
      'echo',
      {},
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'CONNECTION_TIMEOUT',
      details: { operation: 'tools/call', phase: 'call', timeoutMs: 30 },
    },
  });
  const bounded = client(fixture.url, {
    discovery: { timeoutMs: 30 },
    call: { timeoutMs: 200 },
  });
  try {
    await bounded.initialize(undefined);
    await expect(bounded.request('tools/list', {}, undefined)).rejects.toMatchObject({
      operation: 'tools/list',
      phase: 'discovery',
      timeoutMs: 30,
    });
  } finally {
    bounded.teardown();
  }
});

test('shared bounds remain the baseline and individual override fields inherit independently', async () => {
  const fixture = mcpFixture({
    reply: (message) =>
      message.method === 'tools/call'
        ? { result: { value: 'x'.repeat(300) }, delayMs: 50 }
        : {},
  });
  const bounded = new McpHttpClient('shared', 'fixture', {
    transport: { url: fixture.url.href },
    allowedHosts: new Set([fixture.url.host]),
    timeoutMs: 30,
    maxResponseBytes: 200,
    limits: { discovery: { timeoutMs: 100 }, call: { timeoutMs: 100 } },
  });
  try {
    await bounded.initialize(undefined);
    await expect(bounded.request('tools/call', {}, undefined)).rejects.toMatchObject({
      maxBytes: 200,
      phase: 'call',
    });
  } finally {
    bounded.teardown();
  }
  const allowed = new McpHttpClient('shared', 'fixture', {
    transport: { url: fixture.url.href },
    allowedHosts: new Set([fixture.url.host]),
    timeoutMs: 100,
    maxResponseBytes: 200,
    limits: { call: { maxResponseBytes: 500 } },
  });
  try {
    await allowed.initialize(undefined);
    expect(await allowed.request('tools/call', {}, undefined)).toEqual({
      value: 'x'.repeat(300),
    });
  } finally {
    allowed.teardown();
  }
});

test.each([400, 404, 405])(
  'tools/call status %i never negotiates or replays the call',
  async (status) => {
    const fixture = mcpFixture({
      reply: (message) => (message.method === 'tools/call' ? { status } : {}),
    });
    const connection = client(fixture.url);
    try {
      await connection.initialize(undefined);
      await expect(connection.request('tools/call', {}, undefined)).rejects.toMatchObject({
        status,
        operation: 'tools/call',
        phase: 'call',
      });
    } finally {
      connection.teardown();
    }
    expect(fixture.seen.filter((method) => method === 'tools/call')).toHaveLength(1);
    expect(fixture.seen).not.toContain('GET');
  },
);

test('tools/list status 404 cannot negotiate after initialize', async () => {
  const fixture = mcpFixture({
    reply: (message) => (message.method === 'tools/list' ? { status: 404 } : {}),
  });
  await expect(mounted(fixture.url)).rejects.toMatchObject({
    status: 404,
    operation: 'tools/list',
    phase: 'discovery',
  });
  expect(fixture.seen).not.toContain('GET');
});

test('one initialize deadline spans Streamable-to-legacy fallback', async () => {
  const fixture = mcpFixture({ mode: 'legacy', negotiateDelayMs: 45, endpointDelayMs: 45 });
  const bounded = client(fixture.url, { discovery: { timeoutMs: 70 } });
  try {
    await expect(bounded.initialize(undefined)).rejects.toMatchObject({
      operation: 'initialize',
      phase: 'discovery',
      timeoutMs: 70,
    });
  } finally {
    bounded.teardown();
  }
  const allowed = client(fixture.url, { discovery: { timeoutMs: 250 } });
  try {
    await allowed.initialize(undefined);
    expect(await allowed.request('tools/list', {}, undefined)).toHaveProperty('tools');
  } finally {
    allowed.teardown();
  }
});

test('an oversized 400 body is a size refusal and cannot open fallback', async () => {
  const fixture = mcpFixture({ reply: () => ({ status: 400, raw: 'x'.repeat(201) }) });
  const bounded = client(fixture.url, { discovery: { maxResponseBytes: 200 } });
  try {
    await expect(bounded.initialize(undefined)).rejects.toMatchObject({
      maxBytes: 200,
      observedReadBytes: 201,
      operation: 'initialize',
      phase: 'discovery',
    });
  } finally {
    bounded.teardown();
  }
  expect(fixture.seen).not.toContain('GET');
});

test('best-effort initialized notifications preserve deadline and size refusals', async () => {
  for (const failure of ['size', 'deadline']) {
    const fixture = mcpFixture({
      reply: (message) =>
        message.method === 'notifications/initialized'
          ? failure === 'size'
            ? { raw: 'x'.repeat(201) }
            : { hold: true }
          : {},
    });
    const bounded = client(fixture.url, {
      discovery: { maxResponseBytes: 200, timeoutMs: 40 },
    });
    try {
      await expect(bounded.initialize(undefined)).rejects.toMatchObject({
        operation: 'notifications/initialized',
        phase: 'discovery',
        name:
          failure === 'size' ? 'ConnectionResponseTooLargeError' : 'ConnectionTimeoutError',
      });
    } finally {
      bounded.teardown();
    }
  }
  const ignored = mcpFixture({
    reply: (message) =>
      message.method === 'notifications/initialized' ? { status: 404 } : {},
  });
  const allowed = client(ignored.url);
  try {
    await allowed.initialize(undefined);
    expect(ignored.seen).not.toContain('GET');
  } finally {
    allowed.teardown();
  }
});

test('caller abort preserves its exact reason instead of becoming a timeout', async () => {
  const fixture = mcpFixture({ reply: () => ({ hold: true }) });
  const connection = client(fixture.url);
  const controller = new AbortController();
  const reason = new Error('private caller stop marker');
  const pending = connection
    .initialize(undefined, controller.signal)
    .catch((error: unknown) => error);
  controller.abort(reason);
  expect(await pending).toBe(reason);
  connection.teardown();
});

test.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'invalid connection bounds %s cannot disable protection',
  (value) => {
    const config = { name: 'invalid', transport: { url: 'http://127.0.0.1:1/mcp' } };
    for (const phase of ['discovery', 'call']) {
      expect(() =>
        defineMcpClientConnection({ ...config, limits: { [phase]: { timeoutMs: value } } }),
      ).toThrow(RangeError);
      expect(() =>
        defineMcpClientConnection({
          ...config,
          limits: { [phase]: { maxResponseBytes: value } },
        }),
      ).toThrow(RangeError);
    }
    expect(() => defineMcpClientConnection({ ...config, timeoutMs: value })).toThrow(
      RangeError,
    );
    expect(() => defineMcpClientConnection({ ...config, maxResponseBytes: value })).toThrow(
      RangeError,
    );
  },
);

test('timeouts outside the runtime timer range fail at definition', () => {
  expect(() =>
    defineMcpClientConnection({
      name: 'invalid',
      transport: { url: 'http://127.0.0.1:1/mcp' },
      limits: { discovery: { timeoutMs: 2_147_483_648 } },
    }),
  ).toThrow(RangeError);
});
