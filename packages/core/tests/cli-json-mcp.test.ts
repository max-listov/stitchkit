import { afterEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { runNativeCommand } from '../src/entrypoints/process';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();
const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

const Input = z.strictObject({
  productId: z.string().nullable(),
  count: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  text: z.string().optional(),
});
const Rpc = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.object({ arguments: z.unknown().optional() }).optional(),
});

function server(answer: (input: unknown) => object) {
  const received: unknown[] = [];
  const instance = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const rpc = Rpc.parse(await request.json());
      if (rpc.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'upsert',
                    description: 'Upsert a synthetic item',
                    inputSchema: z.toJSONSchema(Input),
                  },
                ],
              }
            : (() => {
                received.push(rpc.params?.arguments);
                return answer(rpc.params?.arguments);
              })();
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  servers.push(instance);
  return { url: `http://127.0.0.1:${instance.port}/mcp`, received };
}

async function cli(url: string, args: string[]) {
  const result = await runNativeCommand({
    executable: process.execPath,
    args: [`${import.meta.dir}/fixtures/cli-json-mcp.ts`, url, ...args],
    timeoutMs: 10_000,
    capture: true,
    maxOutputBytes: 8192,
    onLeaderStarted: trackGroupLeader,
  });
  expect(result.signal).toBeNull();
  return {
    code: result.exitCode,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

test('discovered nullable inputs preserve explicit null, lexical null and omission through a process', async () => {
  const remote = server((input) => ({ content: [], structuredContent: input }));
  const free = await cli(remote.url, [
    'upsert',
    '--productId:=null',
    '--count:=null',
    '--text=null',
    '--json',
  ]);
  expect(free).toEqual({
    code: 0,
    out: '{"productId":null,"count":null,"text":"null"}\n',
    err: '',
  });
  const lexical = await cli(remote.url, ['upsert', '--productId=null', '--json']);
  expect(lexical).toEqual({ code: 0, out: '{"productId":"null"}\n', err: '' });
  expect(remote.received).toEqual([
    { productId: null, count: null, text: 'null' },
    { productId: 'null' },
  ]);
  const rejected = await cli(remote.url, [
    'upsert',
    '--productId:=null',
    '--text:=null',
    '--json',
  ]);
  expect(rejected.code).not.toBe(0);
  expect(rejected.out).toBe('');
  expect(rejected.err).toContain('VALIDATION_ERROR');
  expect(remote.received).toHaveLength(2);
});

test('discovered help advertises JSON null without dispatching an operation', async () => {
  const remote = server(() => {
    throw new Error('help must not call');
  });
  const help = await cli(remote.url, ['upsert', '--help']);
  expect(help.code).toBe(0);
  expect(help.out).toContain('--productId:=null');
  expect(help.out).toContain('--productId null');
  expect(remote.received).toEqual([]);
});

test('an explicit MCP refusal exits nonzero with its structured error and no stdout', async () => {
  const failure = {
    error: 'ITEM_NOT_FOUND',
    retryable: false,
    details: { message: 'Synthetic item missing' },
  };
  for (const structured of [false, true]) {
    const remote = server(() => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(failure) }],
      ...(structured ? { structuredContent: failure } : {}),
    }));
    const result = await cli(remote.url, ['upsert', '--productId=null', '--json']);
    expect(result.code).toBe(4);
    expect(result.out).toBe('');
    expect(JSON.parse(result.err)).toEqual(failure);
  }
});

test('a success payload with an error-named field is still data, never an inferred refusal', async () => {
  const data = { error: 'diagnostic field', count: 0 };
  const remote = server(() => ({ isError: false, content: [], structuredContent: data }));
  const result = await cli(remote.url, ['upsert', '--productId:=null', '--json']);
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(JSON.parse(result.out)).toEqual(data);
});
