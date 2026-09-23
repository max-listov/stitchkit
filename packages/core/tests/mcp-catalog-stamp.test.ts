import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { createImplement } from '../src/server/implement';
import {
  MCP_CATALOG_META_KEY,
  mcpCatalogStamp,
  readMcpCatalogStamp,
} from '../src/tools/mcp/catalog';
import { buildMcpServer } from '../src/tools/mcp/mount';
import { prepareMcpServerSurface } from '../src/tools/mcp/prepare';

/*
 * A consumer must be able to learn that its catalog is stale WITHOUT asking.
 *
 * The incident behind this: a session listed the tools, lived five hours, and the server changed
 * its contract in between. Every later call was refused, and from inside the consumer the stale
 * catalog is invisible — so the refusal reads as "the source is broken". The only signal that can
 * reach such a consumer is one carried by responses it already receives, which is what the catalog
 * stamp is. `notifications/tools/list_changed` is the push-shaped answer and this framework's MCP
 * HTTP handler is stateless by construction, so it has no session to push down.
 */

const implement = createImplement();

function service(actorField: 'by' | 'actor') {
  const contract = defineContract(
    { prefix: 'journal', scope: 'public' },
    {
      record: {
        method: 'POST',
        path: '/record',
        desc: 'Record one journal entry',
        expose: ['MCP'],
        input:
          actorField === 'by' ? z.object({ by: z.string() }) : z.object({ actor: z.string() }),
        output: z.object({ recorded: z.boolean() }),
      },
    },
  );
  return implement(contract, { record: () => ({ recorded: true }) });
}

function serverFor(actorField: 'by' | 'actor'): McpServer {
  return buildMcpServer({
    serverInfo: { name: 'journal', version: '1' },
    services: [service(actorField)],
  });
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('the advertised MCP catalog carries a stamp a consumer can compare', () => {
  test('the same surface always stamps the same digest', () => {
    const left = mcpCatalogStamp(prepareMcpServerSurface({ services: [service('by')] }));
    const right = mcpCatalogStamp(prepareMcpServerSurface({ services: [service('by')] }));
    expect(left).toEqual(right);
    expect(left.tools).toBe(1);
  });

  test('renaming one input field moves the digest', () => {
    const before = mcpCatalogStamp(prepareMcpServerSurface({ services: [service('by')] }));
    const after = mcpCatalogStamp(prepareMcpServerSurface({ services: [service('actor')] }));
    expect(after.digest).not.toBe(before.digest);
  });

  test('a listed tool carries the stamp, so a consumer can store it', async () => {
    const client = await connect(serverFor('by'));
    const listed = await client.listTools();
    const stamp = readMcpCatalogStamp(listed.tools[0]?._meta);
    expect(stamp).toEqual(
      mcpCatalogStamp(prepareMcpServerSurface({ services: [service('by')] })),
    );
    await client.close();
  });

  test('a successful call carries the same stamp the listing did', async () => {
    const client = await connect(serverFor('by'));
    const listed = await client.listTools();
    const result = await client.callTool({
      name: 'record_journal',
      arguments: { by: 'max' },
    });
    expect(readMcpCatalogStamp(result._meta)).toEqual(
      readMcpCatalogStamp(listed.tools[0]?._meta),
    );
    await client.close();
  });

  test('a refusal caused by a stale catalog carries the live stamp too', async () => {
    // What the stale consumer does: it holds the old catalog, sends the field the
    // contract used to have, and is refused. Without the stamp the refusal is the
    // only evidence it gets, and the refusal never mentions the catalog.
    const stale = readMcpCatalogStamp(
      (await (await connect(serverFor('by'))).listTools()).tools[0]?._meta,
    );
    const client = await connect(serverFor('actor'));
    const refusal = await client.callTool({
      name: 'record_journal',
      arguments: { by: 'max' },
    });
    expect(refusal.isError).toBe(true);
    const live = readMcpCatalogStamp(refusal._meta);
    expect(live).not.toBeNull();
    expect(live?.digest).not.toBe(stale?.digest);
    await client.close();
  });

  test('the refusal itself names the field the live contract wants', async () => {
    const client = await connect(serverFor('actor'));
    const refusal = await client.callTool({
      name: 'record_journal',
      arguments: { by: 'max' },
    });
    expect(JSON.stringify(refusal.content)).toContain('actor');
    await client.close();
  });

  test('a peer stamp that is not a stamp is refused rather than half-read', () => {
    expect(readMcpCatalogStamp(undefined)).toBeNull();
    expect(readMcpCatalogStamp({})).toBeNull();
    expect(
      readMcpCatalogStamp({ [MCP_CATALOG_META_KEY]: { digest: '', tools: 1 } }),
    ).toBeNull();
    expect(
      readMcpCatalogStamp({ [MCP_CATALOG_META_KEY]: { digest: 'abc', tools: -1 } }),
    ).toBeNull();
    expect(
      readMcpCatalogStamp({ [MCP_CATALOG_META_KEY]: { digest: 'abc', tools: 2 } }),
    ).toEqual({ digest: 'abc', tools: 2 });
  });
});
