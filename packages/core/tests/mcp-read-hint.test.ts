/**
 * A read says it reads on the MCP surface, and a CLI mounted over that surface
 * acts on it.
 *
 * A CLI that mounts a server's tools through `defineMcpClientConnection` never
 * sees the contract: every MCP call is a POST, so the only thing that can tell
 * it a tool reads is the hint the server publishes. The server publishes
 * `readOnlyHint: true` for a `GET` that declared none, the client carries the
 * published hints onto the mounted tool, and the refused-view rule then holds
 * over MCP exactly as it does over the contract.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import { defineRuntimeTool } from '../src/entrypoints/tools';
import {
  defineMcpClientConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { createImplement } from '../src/server/implement';
import { createCli } from '../src/tools/cli/create-cli';
import { mcpCatalogStamp } from '../src/tools/mcp/catalog';
import { createMcpHandler } from '../src/tools/mcp/handler';
import { buildMcpServer } from '../src/tools/mcp/mount';
import { prepareMcpServerSurface } from '../src/tools/mcp/prepare';
import { readDiscoveredToolAnnotations } from '../src/tools/read-operation';

const Bots = z.array(z.object({ id: z.string(), name: z.string() }));
const bots = [
  { id: 'b1', name: 'first' },
  { id: 'b2', name: 'second' },
];

function botsContract(rotate: { readOnlyHint?: boolean } = { readOnlyHint: false }) {
  return defineContract(
    { prefix: 'bots', scope: 'public' },
    {
      list: {
        method: 'GET',
        path: '/',
        desc: 'List bots',
        expose: ['MCP'],
        output: Bots,
        tool: { name: 'bot_list' },
      },
      rotate: {
        method: 'GET',
        path: '/rotate',
        desc: 'Rotate tokens and list the bots they belong to',
        expose: ['MCP'],
        output: Bots,
        tool: { name: 'token_rotate', annotations: rotate },
      },
      purge: {
        method: 'GET',
        path: '/purge',
        desc: 'Purge and list what was purged',
        expose: ['MCP'],
        output: Bots,
        tool: { name: 'bot_purge', annotations: { destructiveHint: true, title: 'Purge' } },
      },
      create: {
        method: 'POST',
        path: '/',
        desc: 'Create bots',
        expose: ['MCP'],
        output: Bots,
        tool: { name: 'bot_create' },
      },
    },
  );
}

const implement = createImplement<RuntimeContext>();
let calls = 0;
function botsService(contract = botsContract()) {
  const answer = () => {
    calls += 1;
    return bots;
  };
  return implement(contract, { list: answer, rotate: answer, purge: answer, create: answer });
}

const runtimeRead = defineRuntimeTool({
  name: 'clock_read',
  description: 'Read the clock',
  identity: { serviceName: 'clock', action: 'read', method: 'GET' },
  input: z.object({}),
  output: z.object({ now: z.string() }),
  handler: () => ({ now: 'noon' }),
});

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  calls = 0;
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

async function listedAnnotations(): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'read-hint-test', version: '1' });
  const server = buildMcpServer(
    {
      serverInfo: { name: 'bots', version: '1' },
      services: [botsService()],
      runtimeTools: [runtimeRead],
    },
    undefined,
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
}

/** A consuming project's path: a Stitchkit `/mcp` over HTTP, mounted into a CLI through the client connection. */
async function botsCli(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const handler = createMcpHandler({
    serverInfo: { name: 'bots', version: '1' },
    auth: () => ({}),
    context: () => ({}),
    services: [botsService()],
  });
  const server = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
  stops.push(async () => {
    await server.stop(true);
    await handler.close();
  });
  const runtimeTools = await mountConnections([
    defineMcpClientConnection({
      name: 'bots',
      transport: { url: `http://127.0.0.1:${server.port}/mcp` },
      transports: ['CLI'],
    }),
  ]);
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'bots',
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

describe('the MCP server publishes whether a tool reads', () => {
  test('a GET without a declared hint is published read-only, and nothing else is touched', async () => {
    const annotations = await listedAnnotations();
    expect(annotations.bot_list).toEqual({ readOnlyHint: true });
    expect(annotations.clock_read).toEqual({ readOnlyHint: true });
    expect(annotations.token_rotate).toEqual({ readOnlyHint: false });
    expect(annotations.bot_purge).toEqual({ destructiveHint: true, title: 'Purge' });
    expect(annotations.bot_create).toBeUndefined();
  });

  test('the catalog stamp hashes what is published, so a declared false moves it', () => {
    const stamp = (rotate: { readOnlyHint?: boolean }) =>
      mcpCatalogStamp(
        prepareMcpServerSurface({ services: [botsService(botsContract(rotate))] }),
      );
    // Declared `true` and the derived hint publish the same bytes; `false` does not.
    expect(stamp({ readOnlyHint: true }).digest).toBe(stamp({}).digest);
    expect(stamp({ readOnlyHint: false }).digest).not.toBe(stamp({}).digest);
  });
});

describe('a CLI mounted over MCP withholds a refused read view', () => {
  test('a read prints nothing on stdout and says so', async () => {
    const { out, err, code } = await botsCli(['bot_list', '--table', 'id,nosuchcolumn']);
    expect(out).toBe('');
    expect(code).toBe(8);
    const diagnostic = JSON.parse(err);
    expect(diagnostic.error).toBe('CLI_PRESENTATION_FAILED');
    expect(diagnostic.details.resultOnStdout).toBe(false);
    expect(JSON.stringify(diagnostic)).toContain('nosuchcolumn');
    expect(calls).toBe(1);
  });

  test('a known column of the same read still renders its table', async () => {
    const { out, err, code } = await botsCli(['bot_list', '--table', 'id']);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('b1');
  });

  test.each([
    ['a POST', 'bot_create'],
    ['a GET declared not read-only', 'token_rotate'],
    ['a GET declared destructive', 'bot_purge'],
  ])('%s keeps its result on stdout', async (_label, command) => {
    const { out, err, code } = await botsCli([command, '--table', 'id,nosuchcolumn']);
    expect(code).toBe(8);
    // MCP carries an array answer as `{ result: [...] }`; the CLI prints what it received.
    expect(JSON.parse(out)).toEqual({ result: bots });
    expect(JSON.parse(err).details.resultOnStdout).toBe(true);
  });
});

describe("a foreign server's annotations are read field by field", () => {
  test('known fields of the right type are kept', () => {
    expect(
      readDiscoveredToolAnnotations({
        title: 'List',
        readOnlyHint: true,
        openWorldHint: false,
      }),
    ).toEqual({ title: 'List', readOnlyHint: true, openWorldHint: false });
  });

  test('a field of the wrong type is dropped and the rest survive', () => {
    expect(
      readDiscoveredToolAnnotations({ readOnlyHint: 'yes', idempotentHint: true, extra: 1 }),
    ).toEqual({ idempotentHint: true });
  });

  test.each([[null], [undefined], ['read-only'], [[true]], [{}], [{ readOnlyHint: 1 }]])(
    '%p carries no hints',
    (raw) => {
      expect(readDiscoveredToolAnnotations(raw)).toBeUndefined();
    },
  );
});
