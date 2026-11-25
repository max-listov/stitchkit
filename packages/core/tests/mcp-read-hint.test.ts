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
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import { defineRuntimeTool } from '../src/entrypoints/tools';
import { createImplement } from '../src/server/implement';
import { mcpCatalogStamp } from '../src/tools/mcp/catalog';
import { buildMcpServer } from '../src/tools/mcp/mount';
import { prepareMcpServerSurface } from '../src/tools/mcp/prepare';
import { readDiscoveredToolAnnotations } from '../src/tools/read-operation';
import {
  ALL_OPERATION_ORIGINS,
  mountOperationOrigins,
  type OperationOrigin,
} from './support/operation-origins';
import { runCliSurface } from './support/operation-transports';

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

afterEach(() => {
  calls = 0;
});

async function listedAnnotations(): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'read-hint-test', version: '1' });
  const server = buildMcpServer(
    {
      access: { open: 'local-operator' },
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
  const OpenBots = z.array(z.looseObject({ id: z.string(), name: z.string() }));
  let mounted: Awaited<ReturnType<typeof mountOperationOrigins>>;

  beforeAll(async () => {
    const answer = () => {
      calls += 1;
      return bots;
    };
    mounted = await mountOperationOrigins({
      serviceName: 'bots',
      specs: [
        {
          name: 'bot_list',
          description: 'List bots',
          method: 'GET',
          input: z.object({}),
          output: OpenBots,
          handler: answer,
        },
        {
          name: 'token_rotate',
          description: 'Rotate tokens and list the bots they belong to',
          method: 'GET',
          input: z.object({}),
          output: OpenBots,
          annotations: { readOnlyHint: false },
          handler: answer,
        },
        {
          name: 'bot_purge',
          description: 'Purge and list what was purged',
          method: 'GET',
          input: z.object({}),
          output: OpenBots,
          annotations: { destructiveHint: true, title: 'Purge' },
          handler: answer,
        },
        {
          name: 'bot_create',
          description: 'Create bots',
          method: 'POST',
          input: z.object({}),
          output: OpenBots,
          handler: answer,
        },
      ],
    });
  });

  afterAll(async () => {
    await mounted?.close();
  });

  const mcpSurface = () => {
    const surface = mounted.byOrigin.get('discovered-mcp');
    if (!surface) throw new Error('missing discovered-mcp surface');
    return surface;
  };

  test.each(ALL_OPERATION_ORIGINS)(
    'a read prints nothing on stdout and says so (origin: %s)',
    async (origin: OperationOrigin) => {
      const surface = mounted.byOrigin.get(origin);
      if (!surface) throw new Error(`missing mounted origin ${origin}`);
      if (origin === 'managed-cli-catalog') expect(surface.catalogCacheHit).toBe(true);
      const before = calls;
      const { out, err, code } = await runCliSurface(
        surface,
        [surface.commandName('bot_list'), '--table', 'id,nosuchcolumn'],
        { name: 'bots' },
      );
      expect(out).toBe('');
      expect(code).toBe(8);
      const diagnostic = JSON.parse(err);
      expect(diagnostic.error).toBe('CLI_PRESENTATION_FAILED');
      expect(diagnostic.details.resultOnStdout).toBe(false);
      expect(JSON.stringify(diagnostic)).toContain('nosuchcolumn');
      expect(calls).toBe(before + 1);
    },
  );

  test('a known column of the same read still renders its table', async () => {
    const { out, err, code } = await runCliSurface(
      mcpSurface(),
      ['bot_list', '--table', 'id'],
      {
        name: 'bots',
      },
    );
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('b1');
  });

  test.each([
    ['a POST', 'bot_create'],
    ['a GET declared not read-only', 'token_rotate'],
    ['a GET declared destructive', 'bot_purge'],
  ])('%s keeps its result on stdout', async (_label, command) => {
    const { out, err, code } = await runCliSurface(
      mcpSurface(),
      [command, '--table', 'id,nosuchcolumn'],
      { name: 'bots' },
    );
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
