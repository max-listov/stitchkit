import { expect, test } from 'bun:test';
import {
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
} from '../src/entrypoints/tools/connections';
import {
  readBoundedText,
  readConnectionErrorText,
  withConnectionDeadline,
} from '../src/tools/connections/limits';
import { McpHttpClient } from '../src/tools/connections/mcp-client';
import { connectionReadContext } from '../src/tools/connections/operation-limits';
import { readSseFrames } from '../src/tools/connections/sse-frames';
import { mcpFixture } from './connections-fixture';

function streamed(text: string, chunkSize: number, headers?: HeadersInit, complete = true) {
  const bytes = new TextEncoder().encode(text);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      if (complete) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers }),
    bytes: bytes.byteLength,
    get cancelled() {
      return cancelled;
    },
  };
}
function context(maxResponseBytes: number, timeoutMs = 1000) {
  const limits = { timeoutMs, maxResponseBytes };
  return connectionReadContext('tools/call', { discovery: limits, call: limits });
}
async function frames(response: Response, limit: number) {
  const output = [];
  for await (const frame of readSseFrames(response, limit, 'wire', {
    totalLimit: true,
    context: context(limit),
  }))
    output.push(frame);
  return output;
}
function client(
  url: URL,
  discoveryBytes: number,
  callBytes: number,
  discoveryTime = 1000,
  callTime = 1000,
) {
  return new McpHttpClient('wire', 'fixture', {
    transport: { url: url.href },
    allowedHosts: new Set([url.host]),
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    limits: {
      discovery: { maxResponseBytes: discoveryBytes, timeoutMs: discoveryTime },
      call: { maxResponseBytes: callBytes, timeoutMs: callTime },
    },
  });
}

test.each([1, 2, 4096])(
  'raw UTF-8 text accepts exactly N bytes and refuses N+1 for chunk size %i',
  async (chunkSize) => {
    const text = 'á🙂z';
    const exact = streamed(text, chunkSize, { 'content-length': '1' });
    expect(
      await readBoundedText(exact.response, exact.bytes, 'wire', context(exact.bytes)),
    ).toBe(text);
    const over = streamed(text, chunkSize, undefined, false);
    const error = await readBoundedText(
      over.response,
      over.bytes - 1,
      'wire',
      context(over.bytes - 1),
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConnectionResponseTooLargeError);
    expect(error).toMatchObject({
      maxBytes: over.bytes - 1,
      observedReadBytes: over.bytes,
      phase: 'call',
      operation: 'tools/call',
    });
    expect(over.cancelled).toBe(true);
  },
);

test.each(['\n', '\r\n'])(
  'finite SSE counts framing, comments and raw UTF-8 across %s delimiters',
  async (line) => {
    const text = `: ignored${line}${line}event: message${line}data: {"id":1,"result":"🙂"}${line}${line}`;
    const exact = streamed(text, 1, { 'content-length': '0' });
    expect(await frames(exact.response, exact.bytes)).toEqual([
      { event: 'message', data: '' },
      { event: 'message', data: '{"id":1,"result":"🙂"}' },
    ]);
    const over = streamed(text, 1, undefined, false);
    await expect(frames(over.response, over.bytes - 1)).rejects.toMatchObject({
      observedReadBytes: over.bytes,
      maxBytes: over.bytes - 1,
    });
    expect(over.cancelled).toBe(true);
  },
);

test('a partial SSE frame is bounded before decoded concatenation', async () => {
  const partial = streamed(`data: ${'🙂'.repeat(200)}`, 1);
  await expect(frames(partial.response, 32)).rejects.toMatchObject({
    maxBytes: 32,
    observedReadBytes: 33,
  });
  expect(partial.cancelled).toBe(true);
});

test('mixed SSE newline styles retain bounded raw framing', async () => {
  const text = 'event: message\ndata: first\n\r\nevent: message\r\ndata: second\r\n\n';
  const exact = streamed(text, 1);
  expect(await frames(exact.response, exact.bytes)).toEqual([
    { event: 'message', data: 'first' },
    { event: 'message', data: 'second' },
  ]);
});

test('a body reader that ignores fetch still terminates on its deadline and cancels', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([65]));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const read = context(100, 20);
  const error = await withConnectionDeadline('wire', read, undefined, (scoped) =>
    readBoundedText(response, 100, 'wire', scoped),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ConnectionTimeoutError);
  expect(error).toMatchObject({
    observedReadBytes: 1,
    operation: 'tools/call',
    phase: 'call',
    timeoutMs: 20,
  });
  expect(cancelled).toBe(true);
});

test('best-effort error-body reading preserves exact caller abort and typed bounds', async () => {
  const controller = new AbortController();
  const reason = { private: 'cancel marker' };
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const read = context(100);
  read.signal = controller.signal;
  const pending = readConnectionErrorText(response, 'wire', read).catch(
    (error: unknown) => error,
  );
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(cancelled).toBe(true);
  const large = streamed('x'.repeat(101), 1);
  await expect(
    readConnectionErrorText(large.response, 'wire', context(100)),
  ).rejects.toMatchObject({ observedReadBytes: 101 });
  const failed = new Response(
    new ReadableStream({
      start(stream) {
        stream.error(new Error('unreadable internal diagnostic'));
      },
    }),
  );
  expect(await readConnectionErrorText(failed, 'wire', context(100))).toBe('');
});

const streamModes: ('finite-sse' | 'legacy')[] = ['finite-sse', 'legacy'];
test.each(streamModes)(
  '%s pending response accepts exactly N raw UTF-8 bytes and refuses N+1',
  async (mode) => {
    const value = '🙂';
    const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { value } })}\n\n`;
    const bytes = new TextEncoder().encode(frame).byteLength;
    const fixture = mcpFixture({
      mode,
      reply: (message) => (message.method === 'tools/call' ? { result: { value } } : {}),
    });
    const exact = client(fixture.url, 2000, bytes);
    try {
      await exact.initialize(undefined);
      expect(await exact.request('tools/call', {}, undefined)).toEqual({ value });
    } finally {
      exact.teardown();
    }
    const bounded = client(fixture.url, 2000, bytes - 1);
    try {
      await bounded.initialize(undefined);
      await expect(bounded.request('tools/call', {}, undefined)).rejects.toMatchObject({
        operation: 'tools/call',
        phase: 'call',
        maxBytes: bytes - 1,
        observedReadBytes: bytes,
      });
    } finally {
      bounded.teardown();
    }
  },
);

test.each(streamModes)(
  '%s discovery and pending call select independent byte ceilings',
  async (mode) => {
    const fixture = mcpFixture({
      mode,
      tools: [
        { name: 'echo', description: 'x'.repeat(8192), inputSchema: { type: 'object' } },
      ],
      reply: (message) =>
        message.method === 'tools/call' ? { result: { value: '🙂'.repeat(200) } } : {},
    });
    const bounded = client(fixture.url, 12_000, 200);
    try {
      await bounded.initialize(undefined);
      expect(await bounded.request('tools/list', {}, undefined)).toHaveProperty('tools');
      await expect(bounded.request('tools/call', {}, undefined)).rejects.toMatchObject({
        operation: 'tools/call',
        phase: 'call',
        maxBytes: 200,
      });
    } finally {
      bounded.teardown();
    }
    const allowed = client(fixture.url, 12_000, 1500);
    try {
      await allowed.initialize(undefined);
      expect(await allowed.request('tools/call', {}, undefined)).toEqual({
        value: '🙂'.repeat(200),
      });
    } finally {
      allowed.teardown();
    }
    await fixture.streamsClosed();
    expect(fixture.openStreams).toBe(0);
  },
);

test.each(streamModes)(
  '%s wrong-id frames consume the active operation read budget',
  async (mode) => {
    const wrong = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: -1, result: '🙂' })}\n\n`;
    const fixture = mcpFixture({
      mode,
      reply: (message) =>
        message.method === 'tools/call'
          ? mode === 'legacy'
            ? { frames: wrong.repeat(10) }
            : { raw: wrong.repeat(10) }
          : {},
    });
    const bounded = client(fixture.url, 2000, 200);
    try {
      await bounded.initialize(undefined);
      const error = await bounded
        .request('tools/call', {}, undefined)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ConnectionResponseTooLargeError);
      expect(error).toMatchObject({ maxBytes: 200, operation: 'tools/call', phase: 'call' });
      if (!(error instanceof ConnectionResponseTooLargeError))
        throw new Error('Missing size error');
      expect(error.observedReadBytes).toBeGreaterThan(200);
    } finally {
      bounded.teardown();
    }
    await fixture.streamsClosed();
    expect(fixture.openStreams).toBe(0);
  },
);

test('legacy endpoint readiness is bounded but its stream lifetime uses active call deadlines', async () => {
  const fixture = mcpFixture({
    mode: 'legacy',
    reply: (message) => (message.method === 'tools/call' ? { delayMs: 80 } : {}),
  });
  const connection = client(fixture.url, 2000, 2000, 40, 200);
  try {
    await connection.initialize(undefined);
    expect(await connection.request('tools/call', {}, undefined)).toHaveProperty(
      'structuredContent',
    );
  } finally {
    connection.teardown();
  }
  const missing = mcpFixture({ mode: 'legacy', endpointFrames: ': waiting\n\n' });
  const deadline = client(missing.url, 200, 2000, 20, 200);
  try {
    await expect(deadline.initialize(undefined)).rejects.toMatchObject({
      timeoutMs: 20,
      operation: 'initialize',
      phase: 'discovery',
    });
  } finally {
    deadline.teardown();
  }
  const large = mcpFixture({ mode: 'legacy', endpointFrames: ': small\n\n'.repeat(30) });
  const ceiling = client(large.url, 200, 2000);
  try {
    await expect(ceiling.initialize(undefined)).rejects.toMatchObject({
      maxBytes: 200,
      operation: 'initialize',
      phase: 'discovery',
    });
  } finally {
    ceiling.teardown();
  }
  await Promise.all([missing.streamsClosed(), large.streamsClosed()]);
  expect(missing.openStreams).toBe(0);
  expect(large.openStreams).toBe(0);
});
