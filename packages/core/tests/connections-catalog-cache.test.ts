/**
 * A connection keeps its discovered catalog between processes and asks for `tools/list` only
 * when the server's catalog stamp says the catalog moved.
 *
 * The consumer behind this: a CLI on a 40–60 KB/s link re-downloaded a catalog of hundreds of
 * tools (~800 KB) on every start and ran out of its discovery deadline. Its server's `serverInfo`
 * never changes (`version: '1.0.0'`), and which tools a key sees depends on its role, so the key
 * of the cache is the stamp of the surface actually served — over a real `createMcpHandler`, on
 * a real socket, the way the consumer mounts it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  defineMcpClientConnection,
  type McpConnectionCatalogEntry,
  type McpConnectionCatalogStore,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { createImplement } from '../src/server/implement';
import { MCP_CATALOG_HEADER } from '../src/tools/mcp/catalog-stamp';
import { createMcpHandler, type McpHttpHandler } from '../src/tools/mcp/handler';

const implement = createImplement();

function service(prefix: string, names: readonly string[]) {
  const endpoints = Object.fromEntries(
    names.map((name) => [
      name,
      {
        method: 'POST' as const,
        path: `/${name}`,
        desc: `Run ${name}`,
        expose: ['MCP' as const],
        input: z.object({ value: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
    ]),
  );
  const contract = defineContract({ prefix, scope: 'public' }, endpoints);
  const handlers = Object.fromEntries(names.map((name) => [name, () => ({ ok: true })]));
  return implement(contract, handlers);
}

const MEMBER = service('member', ['alpha', 'beta']);
const ADMIN = service('admin', ['gamma']);

interface Served {
  url: string;
  listed: () => number;
  stop: () => void;
}

const running: Served[] = [];
afterEach(() => {
  for (const served of running.splice(0)) served.stop();
});

/** Count `tools/list` requests reaching the handler; `route` picks the handler per request. */
function serve(route: (body: { method?: string }) => McpHttpHandler): Served {
  let listed = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const text = await request.text();
      const body: { method?: string } = text ? JSON.parse(text) : {};
      if (body.method === 'tools/list') listed++;
      return route(body).fetch(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: text,
        }),
      );
    },
  });
  const served = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    listed: () => listed,
    stop: () => void server.stop(true),
  };
  running.push(served);
  return served;
}

function handler(options: { surfaces?: 'role'; extra?: boolean; raw?: boolean } = {}) {
  const security = { allowedHosts: ['127.0.0.1', 'localhost'] };
  if (options.surfaces === 'role') {
    return createMcpHandler({
      serverInfo: { name: 'catalog', version: '1.0.0' },
      security,
      auth: (request: Request) => ({
        admin: request.headers.get('authorization') === 'Bearer admin',
      }),
      surfaces: {
        admin: { services: [MEMBER, ADMIN] },
        member: { services: [MEMBER] },
      },
      selectSurface: (auth) => (auth.admin ? 'admin' : 'member'),
    });
  }
  return createMcpHandler({
    serverInfo: { name: 'catalog', version: '1.0.0' },
    security,
    auth: () => ({}),
    services: options.extra ? [MEMBER, ADMIN] : [MEMBER],
    ...(options.raw && { rawTools: () => undefined }),
  });
}

function memoryStore(): McpConnectionCatalogStore & { entry?: McpConnectionCatalogEntry } {
  const store: McpConnectionCatalogStore & { entry?: McpConnectionCatalogEntry } = {
    load: () => store.entry,
    store: (entry) => {
      // What an application writes to disk is JSON: keep exactly that, not the live object.
      store.entry = JSON.parse(JSON.stringify(entry));
    },
  };
  return store;
}

async function mount(url: string, store: McpConnectionCatalogStore, token = 'member') {
  const tools = await mountConnections(
    [
      defineMcpClientConnection({
        name: 'catalog',
        transport: { url },
        token: () => token,
        catalog: store,
      }),
    ],
    { onSkippedTool: () => undefined },
  );
  return tools.map((tool) => tool.name).sort();
}

describe('a stored catalog is used while the server serves the same one', () => {
  test('the second start lists nothing; a changed catalog lists again', async () => {
    const store = memoryStore();
    let current = handler();
    const served = serve(() => current);

    expect(await mount(served.url, store)).toEqual(['alpha_member', 'beta_member']);
    expect(served.listed()).toBe(1);
    expect(store.entry?.stamp.tools).toBe(2);

    expect(await mount(served.url, store)).toEqual(['alpha_member', 'beta_member']);
    expect(served.listed()).toBe(1);

    // Negative control: the server's catalog moved, the stamp with it — the store is not used.
    current = handler({ extra: true });
    expect(await mount(served.url, store)).toEqual([
      'alpha_member',
      'beta_member',
      'gamma_admin',
    ]);
    expect(served.listed()).toBe(2);
  });

  test("a credential that sees another surface never mounts the other surface's catalog", async () => {
    const store = memoryStore();
    const role = handler({ surfaces: 'role' });
    const served = serve(() => role);
    expect(await mount(served.url, store, 'admin')).toHaveLength(3);
    expect(await mount(served.url, store, 'member')).toEqual(['alpha_member', 'beta_member']);
    expect(served.listed()).toBe(2);
  });

  test('the initialize answer carries the stamp of the served surface', async () => {
    const response = await handler().fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'probe', version: '1' },
          },
        }),
      }),
    );
    expect(JSON.parse(response.headers.get(MCP_CATALOG_HEADER) ?? 'null')).toMatchObject({
      tools: 2,
    });
  });
});

describe('a listing is stored only when it provably is the stamped catalog', () => {
  test('a rolling deploy answering initialize and tools/list from two builds stores nothing', async () => {
    const store = memoryStore();
    const before = handler();
    const after = handler({ extra: true });
    // `initialize` reaches the new build, `tools/list` the old one.
    const served = serve((body) => (body.method === 'tools/list' ? before : after));
    expect(await mount(served.url, store)).toEqual(['alpha_member', 'beta_member']);
    expect(store.entry).toBeUndefined();
  });

  test('a surface with raw SDK tools sends no stamp and is never cached', async () => {
    const store = memoryStore();
    const raw = handler({ raw: true });
    const served = serve(() => raw);
    await mount(served.url, store);
    await mount(served.url, store);
    expect(served.listed()).toBe(2);
    expect(store.entry).toBeUndefined();
  });

  test('a corrupt or foreign stored entry is a miss, and a failing store never fails the mount', async () => {
    const plain = handler();
    const served = serve(() => plain);
    const first = memoryStore();
    await mount(served.url, first);
    const stamp = first.entry?.stamp;
    if (!stamp) throw new Error('the first mount stored nothing');

    // The live stamp with someone else's tools: the per-tool stamps disagree, so it is not used.
    const forged = memoryStore();
    forged.entry = {
      stamp,
      result: { tools: [{ name: 'forged' }, { name: 'forged_too' }] },
    };
    expect(await mount(served.url, forged)).toEqual(['alpha_member', 'beta_member']);

    const broken: McpConnectionCatalogStore = {
      load: () => {
        throw new Error('disk gone');
      },
      store: () => {
        throw new Error('disk gone');
      },
    };
    expect(await mount(served.url, broken)).toEqual(['alpha_member', 'beta_member']);
    expect(served.listed()).toBe(3);
  });
});
