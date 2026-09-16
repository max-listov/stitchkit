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

function startMcp(tools: readonly unknown[]): string {
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
            : { content: [{ type: 'text', text: 'ok' }], echoed: body.params?.arguments };
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
): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'app',
    version: '1.0.0',
    runtimeTools,
    argv,
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
    expect(out).toContain('hello');
    expect(code).toBe(0);
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
});
