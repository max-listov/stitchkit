/**
 * A CLI whose commands come from a running server.
 *
 * `mountConnections` + `createCli` compose into the one shape a compiled CLI
 * cannot get any other way: the surface the server has *now*, rather than the
 * surface the binary was compiled against. The composition needs an opt-in,
 * because CLI exposure is explicit everywhere else in the framework — and it
 * needs the mount to survive one unconvertible tool, or a surface of two
 * hundred is lost to one schema.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { isRecord } from '../src/internal/typed';
import { createCli } from '../src/tools/cli';
import type { SkippedConnectionTool } from '../src/tools/connections';
import { defineMcpClientConnection, mountConnections } from '../src/tools/connections';

interface JsonRpcBody {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

const servers: Array<{ stop: () => Promise<void> | void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop();
});

/**
 * What a server answers `tools/call` with. The default is the shape a stitchkit
 * MCP mount emits: the answer in `structuredContent`, the same answer serialized
 * into a text part for clients that read only content.
 */
type CallEnvelope = (args: unknown) => unknown;

function startMcp(tools: readonly unknown[], envelope?: CallEnvelope): string {
  const answer: CallEnvelope =
    envelope ??
    ((args) => ({
      content: [{ type: 'text', text: JSON.stringify({ echoed: args }) }],
      structuredContent: { echoed: args },
    }));
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method === 'GET') return new Response('', { status: 404 });
      const body: JsonRpcBody = await request.json();
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'fake', version: '1' },
            }
          : body.method === 'tools/list'
            ? { tools }
            : answer(body.params?.arguments);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/mcp`;
}

const ECHO = {
  name: 'echo',
  description: 'Echo a value',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
};

async function runCli(
  runtimeTools: Awaited<ReturnType<typeof mountConnections>>,
  argv: string[],
  exitCodes?: Record<string, number>,
): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'app',
    version: '1.0.0',
    runtimeTools,
    argv,
    ...(exitCodes && { exitCodes }),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { out, err, code };
}

describe('discovered tools on the CLI surface', () => {
  test('a connection that opts in contributes commands with no per-definition rewriting', async () => {
    const url = startMcp([ECHO]);
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const { out, code } = await runCli(discovered, ['--help']);
    expect(out).toContain('echo');
    expect(out).toContain('Echo a value');
    expect(code).toBe(0);
  });

  test('a discovered command actually runs', async () => {
    const url = startMcp([ECHO]);
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const { out, code } = await runCli(discovered, ['echo', '--value', 'hello', '--json']);
    expect(code).toBe(0);
    // The answer, not the envelope carrying it: what is printed is what a pipe
    // and a view will see.
    expect(JSON.parse(out)).toEqual({ echoed: { value: 'hello' } });
  });

  test('a connection without the opt-in contributes nothing to the CLI', async () => {
    const url = startMcp([ECHO]);
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url } }),
    ]);
    expect(discovered).toHaveLength(1);
    const { out } = await runCli(discovered, ['--help']);
    expect(out).not.toContain('echo');
  });

  test('one unconvertible tool is skipped and named, and the rest still mount', async () => {
    const url = startMcp([
      ECHO,
      {
        name: 'broken',
        description: 'Carries a pointer nothing can resolve',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { value: { $ref: '#/definitions/missing' } },
        },
      },
    ]);
    const skipped: SkippedConnectionTool[] = [];
    const discovered = await mountConnections(
      [defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] })],
      { onSkippedTool: (report) => skipped.push(report) },
    );
    expect(discovered.map((tool) => tool.name)).toEqual(['echo']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.connection).toBe('api');
    expect(skipped[0]?.tool).toBe('broken');
    expect(skipped[0]?.reason).toContain('missing');
  });

  test('the CLI prints the answer, so a view groups records rather than parts', async () => {
    const url = startMcp([ECHO], () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { id: 'a', status: 'active' },
            { id: 'b', status: 'idle' },
            { id: 'c', status: 'active' },
          ]),
        },
      ],
    }));
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    // Before the unwrap this answered: no record carries the field "status" —
    // available: text, type. It was grouping the content parts.
    const { out, code } = await runCli(discovered, [
      'echo',
      '--value',
      'x',
      '--count-by',
      'status',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ active: 2, idle: 1 });
  });

  test('structuredContent wins over the text part when the server sent both', async () => {
    const url = startMcp([ECHO], () => ({
      content: [{ type: 'text', text: '"the text part"' }],
      structuredContent: { answer: 'the structured one' },
    }));
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const { out } = await runCli(discovered, ['echo', '--value', 'x', '--json']);
    expect(JSON.parse(out)).toEqual({ answer: 'the structured one' });
  });

  test('a prose answer stays prose, and several parts stay an envelope', async () => {
    const prose = startMcp([ECHO], () => ({ content: [{ type: 'text', text: 'all good' }] }));
    const proseTools = await mountConnections([
      defineMcpClientConnection({
        name: 'api',
        transport: { url: prose },
        transports: ['CLI'],
      }),
    ]);
    expect(
      JSON.parse((await runCli(proseTools, ['echo', '--value', 'x', '--json'])).out),
    ).toBe('all good');

    // Two parts: picking one of them would be inventing an answer.
    const many = startMcp([ECHO], () => ({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    }));
    const manyTools = await mountConnections([
      defineMcpClientConnection({
        name: 'api',
        transport: { url: many },
        transports: ['CLI'],
      }),
    ]);
    const emitted: unknown = JSON.parse(
      (await runCli(manyTools, ['echo', '--value', 'x', '--json'])).out,
    );
    expect(
      isRecord(emitted) && Array.isArray(emitted.content) ? emitted.content.length : 0,
    ).toBe(2);
  });

  test('the agent mount still receives the envelope it needs', async () => {
    const url = startMcp([ECHO], () => ({
      content: [{ type: 'text', text: '{"n":1}' }],
      structuredContent: { n: 1 },
    }));
    const [tool] = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url } }),
    ]);
    if (!tool) throw new Error('nothing mounted');
    const handler = tool.handler as unknown as (
      context: Record<string, unknown>,
    ) => Promise<unknown>;
    const result = await handler({
      input: { value: 'x' },
      params: undefined,
      source: 'agent',
    });
    expect(isRecord(result) && Array.isArray(result.content)).toBe(true);
  });

  test('a remote refusal keeps its code, so exitCodes can map it', async () => {
    const url = startMcp([ECHO], () => ({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'ITEM_NOT_FOUND',
            details: { message: 'no item with that id' },
          }),
        },
      ],
    }));
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const { err, code } = await runCli(discovered, ['echo', '--value', 'x', '--json'], {
      ITEM_NOT_FOUND: 4,
    });
    // Before the relay this exited 1 with "Internal server error": the code and
    // the message were discarded at the throw.
    expect(code).toBe(4);
    const failure: unknown = JSON.parse(err);
    expect(isRecord(failure) ? failure.error : undefined).toBe('ITEM_NOT_FOUND');
    expect(JSON.stringify(failure)).toContain('no item with that id');
  });

  test('a refusal without a structured body still fails, and invents nothing', async () => {
    const url = startMcp([ECHO], () => ({
      isError: true,
      content: [{ type: 'text', text: 'the tool said no' }],
    }));
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const { err, code } = await runCli(discovered, ['echo', '--value', 'x', '--json']);
    expect(code).toBe(1);
    const failure: unknown = JSON.parse(err);
    expect(isRecord(failure) ? failure.error : undefined).toBe('UPSTREAM_TOOL_ERROR');
    // What the server did say is carried, rather than dropped for tidiness.
    expect(JSON.stringify(failure)).toContain('the tool said no');
  });

  test('a relayed refusal is not an unexpected error to the runner', async () => {
    const url = startMcp([ECHO], () => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'FORBIDDEN' }) }],
    }));
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const lines: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args[0]);
    try {
      await runCli(discovered, ['echo', '--value', 'x', '--json']);
    } finally {
      console.error = original;
    }
    // `[stitchkit] unhandled error:` is what printed a code frame of the
    // minified bundle before the JSON failure.
    expect(lines.some((line) => String(line).includes('unhandled error'))).toBe(false);
  });
});

/*
 * A relayed refusal answers the one question it exists to answer.
 *
 * `retryable` was introduced so a model stops paying for repeats that cannot
 * work. Through a discovered MCP tool it did the opposite: the relay rebuilt the
 * remote's refusal with a constant 502, and 502 is a retryable class, so every
 * relayed failure arrived as "try again" — `NOT_FOUND` included. The remote is
 * the only side that knows, it already said so in the envelope, and now that
 * answer is carried instead of re-derived from a constant.
 */
describe('a relayed refusal carries the remote answer, not one derived from 502', () => {
  const refusal = (body: Record<string, unknown>) => () => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  });

  async function failureThroughCli(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = startMcp([ECHO], refusal(body));
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const { err, code } = await runCli(discovered, ['echo', '--value', 'x', '--json']);
    expect(code).not.toBe(0);
    const parsed: unknown = JSON.parse(err);
    if (!isRecord(parsed)) throw new Error(`expected an object failure, got ${err}`);
    return parsed;
  }

  test('a declared `false` survives the hop — the case the constant 502 inverted', async () => {
    const failure = await failureThroughCli({
      error: 'ITEM_NOT_FOUND',
      retryable: false,
      details: { message: 'no item with that id' },
    });
    expect(failure.error).toBe('ITEM_NOT_FOUND');
    // Before the relay read the field this was `true`, and a model calling a
    // missing item again is exactly what the field was added to stop.
    expect(failure.retryable).toBe(false);
  });

  test('a declared `true` survives it too, so the test cannot pass by always saying no', async () => {
    const failure = await failureThroughCli({
      error: 'UPSTREAM_BUSY',
      retryable: true,
      details: { message: 'try again shortly' },
    });
    expect(failure.retryable).toBe(true);
  });

  test("the remote's `_hint` is carried — the refusal keeps its next move", async () => {
    const failure = await failureThroughCli({
      error: 'ITEM_NOT_FOUND',
      retryable: false,
      _hint: 'List items first and use an id from that list.',
      details: { message: 'no item with that id' },
    });
    expect(failure._hint).toBe('List items first and use an id from that list.');
  });

  test('a remote that declares nothing is unchanged: the upstream status still answers', async () => {
    // An older server sends no `retryable` at all. Inventing one from the code
    // name would be guessing; 502 stays the answer, exactly as before.
    const failure = await failureThroughCli({
      error: 'ITEM_NOT_FOUND',
      details: { message: 'no item with that id' },
    });
    expect(failure.retryable).toBe(true);
  });

  test('a non-boolean `retryable` is not a declaration and does not become one', async () => {
    const failure = await failureThroughCli({
      error: 'ITEM_NOT_FOUND',
      retryable: 0,
      details: { message: 'no item with that id' },
    });
    // `0` rather than `'false'` deliberately: a string spelling of a boolean
    // coerces to `true`, which is also the 502 fallback, so that version of this
    // test passed whether the value was read or coerced. `0` coerces to `false`
    // and the fallback is `true`, so the two answers differ and the test can
    // fail. A JSON envelope is free to carry 0/1; neither is a declaration.
    expect(failure.retryable).toBe(true);
  });

  test('an unstructured refusal keeps the framework default', async () => {
    const url = startMcp([ECHO], () => ({
      isError: true,
      content: [{ type: 'text', text: 'the tool said no' }],
    }));
    const discovered = await mountConnections([
      defineMcpClientConnection({ name: 'api', transport: { url }, transports: ['CLI'] }),
    ]);
    const { err } = await runCli(discovered, ['echo', '--value', 'x', '--json']);
    const failure: unknown = JSON.parse(err);
    expect(isRecord(failure) ? failure.error : undefined).toBe('UPSTREAM_TOOL_ERROR');
    // Nothing was parsed, so nothing was declared: upstream failed and we cannot
    // say more than that.
    expect(isRecord(failure) ? failure.retryable : undefined).toBe(true);
  });
});
