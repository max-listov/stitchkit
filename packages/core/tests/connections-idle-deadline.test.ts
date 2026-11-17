/**
 * A slow link that keeps delivering is not a dead one.
 *
 * The consumer behind this: a CLI on a 40–60 KB/s link failed every discovery with
 * "tools/list exceeded 30000 ms" while the catalog was still arriving. A connection's idle
 * deadline ends an exchange only when nothing arrives; the total deadline stays separate, and
 * discovery's default total is long. The server here throttles a real socket to 50 KB/s.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ConnectionTimeoutError,
  defineMcpClientConnection,
  type McpConnectionLimits,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { withIdleDeadline } from '../src/internal/deadline';
import { resolveMcpLimits } from '../src/tools/connections/operation-limits';
import type { RuntimeToolDefinition } from '../src/tools/runtime-tool';

const CHUNK_BYTES = 5 * 1024;
const CHUNK_EVERY_MS = 100; // 5 KB per 100 ms: 50 KB/s

/** About 150 KB of catalog: three seconds at 50 KB/s. */
const CATALOG = {
  tools: Array.from({ length: 60 }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool ${index}. ${'x'.repeat(2_500)}`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  })),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Behaviour {
  /** Stop sending after this many bytes of the `tools/list` body, for `stallMs`. */
  stallAfter?: number;
  stallMs?: number;
  /** A `tools/call` computes this long before it answers. */
  callMs?: number;
  /** Answer `tools/list` as one SSE frame instead of a JSON body. */
  sse?: boolean;
}

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function throttled(text: string, behaviour: Behaviour): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    async start(controller) {
      let sent = 0;
      let stalled = false;
      while (sent < bytes.length) {
        if (!stalled && behaviour.stallAfter !== undefined && sent >= behaviour.stallAfter) {
          stalled = true;
          await sleep(behaviour.stallMs ?? 0);
        }
        controller.enqueue(bytes.subarray(sent, sent + CHUNK_BYTES));
        sent += CHUNK_BYTES;
        await sleep(CHUNK_EVERY_MS);
      }
      controller.close();
    },
  });
}

function serve(behaviour: Behaviour = {}): string {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: async (request) => {
      const body: { id?: number; method: string } = await request.json();
      if (body.id === undefined) return new Response(null, { status: 202 });
      const json = { 'content-type': 'application/json' };
      if (body.method === 'tools/list') {
        const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: CATALOG });
        if (behaviour.sse) {
          return new Response(throttled(`event: message\ndata: ${text}\n\n`, behaviour), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(throttled(text, behaviour), { headers: json });
      }
      if (body.method === 'tools/call') await sleep(behaviour.callMs ?? 0);
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 's', version: '1' },
            }
          : { content: [{ type: 'text', text: 'done' }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result }, { headers: json });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/mcp`;
}

function mount(
  url: string,
  limits?: McpConnectionLimits,
): Promise<readonly RuntimeToolDefinition[]> {
  return mountConnections(
    [
      defineMcpClientConnection({
        name: 'slow',
        transport: { url },
        ...(limits && { limits }),
      }),
    ],
    { budget: { maxTools: 1000, maxSchemaBytes: 8_000_000 } },
  );
}

async function failure(pending: Promise<unknown>): Promise<ConnectionTimeoutError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof ConnectionTimeoutError) return error;
    throw error;
  }
  throw new Error('expected a connection timeout');
}

describe('discovery on a 50 KB/s link', () => {
  test('defaults: a long total deadline and a 30 s idle one for discovery, none for a call', () => {
    expect(resolveMcpLimits({})).toEqual({
      discovery: { timeoutMs: 300_000, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 30_000 },
      call: { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024 },
    });
    // A declared deadline keeps its meaning: no idle deadline unless one is declared too.
    expect(
      resolveMcpLimits({ timeoutMs: 5_000, limits: { call: { idleTimeoutMs: 700 } } }),
    ).toEqual({
      discovery: { timeoutMs: 5_000, maxResponseBytes: 1024 * 1024 },
      call: { timeoutMs: 5_000, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 700 },
    });
    expect(
      resolveMcpLimits({ limits: { discovery: { timeoutMs: 120_000 } } }).discovery,
    ).toEqual({ timeoutMs: 120_000, maxResponseBytes: 1024 * 1024 });
  });

  test('a catalog that keeps arriving mounts under the defaults', async () => {
    const tools = await mount(serve());
    expect(tools).toHaveLength(60);
  }, 20_000);

  test('every chunk restarts the idle deadline: 300 ms of quiet allowed, three seconds of transfer', async () => {
    const tools = await mount(serve(), { discovery: { idleTimeoutMs: 300 } });
    expect(tools).toHaveLength(60);
  }, 20_000);

  test('an SSE answer counts its chunks the same way', async () => {
    const tools = await mount(serve({ sse: true }), {
      discovery: { idleTimeoutMs: 300, maxResponseBytes: 4 * 1024 * 1024 },
    });
    expect(tools).toHaveLength(60);
  }, 20_000);

  test('negative control: the same link under a one-second total deadline fails as before', async () => {
    const error = await failure(mount(serve(), { discovery: { timeoutMs: 1_000 } }));
    expect(error.deadline).toBe('total');
    expect(error.operation).toBe('tools/list');
    expect(error.observedReadBytes).toBeGreaterThan(0);
  }, 20_000);

  test('a link that goes silent fails on the idle deadline, naming it', async () => {
    const url = serve({ stallAfter: 20 * 1024, stallMs: 2_000 });
    const error = await failure(mount(url, { discovery: { idleTimeoutMs: 400 } }));
    expect(error.deadline).toBe('idle');
    expect(error.timeoutMs).toBe(400);
    expect(error.message).toContain('received nothing for 400 ms');
    expect(error.observedReadBytes).toBeGreaterThanOrEqual(20 * 1024);
  }, 20_000);
});

describe('a call computing in silence', () => {
  test('is not cut off by default, and is by an idle deadline it declares', async () => {
    const url = serve({ callMs: 600 });
    const [tool] = await mount(url);
    if (!tool) throw new Error('no tool mounted');
    await expect(
      Promise.resolve(tool.handler({ input: {}, params: undefined, source: 'agent' })),
    ).resolves.toBeDefined();

    const [bounded] = await mount(url, { call: { idleTimeoutMs: 200 } });
    if (!bounded) throw new Error('no tool mounted');
    const error = await failure(
      Promise.resolve(bounded.handler({ input: {}, params: undefined, source: 'agent' })),
    );
    expect(error.deadline).toBe('idle');
    expect(error.phase).toBe('call');
  }, 20_000);
});

describe('the idle deadline itself', () => {
  test('progress restarts it; a touch after the body settled re-arms nothing', async () => {
    let fired = 0;
    let late: (() => void) | undefined;
    const value = await withIdleDeadline(
      50,
      new AbortController().signal,
      () => {
        fired++;
        return new Error('idle');
      },
      async (idle) => {
        for (let step = 0; step < 6; step++) {
          await sleep(25);
          idle.touch();
        }
        late = idle.touch;
        return 'done';
      },
    );
    expect(value).toBe('done');
    late?.();
    await sleep(120);
    expect(fired).toBe(0);
  });

  test('silence aborts with the reason given', async () => {
    const reason = await withIdleDeadline(
      30,
      new AbortController().signal,
      () => new Error('quiet'),
      (idle) =>
        new Promise((resolve) =>
          idle.signal.addEventListener('abort', () => resolve(idle.signal.reason)),
        ),
    );
    expect(reason).toBeInstanceOf(Error);
    expect(String(reason)).toContain('quiet');
  });
});
