/**
 * A tool view — one endpoint, one handler, a full record on HTTP and a card on
 * the tool surface. Every claim of ADR 0196 is held by the test named after it,
 * on every path it is made for: HTTP, MCP, AGENT, CLI, the in-process invoker
 * and `implementRemote`.
 */
import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createHttpClient } from '../src/browser/http';
import { DECLARED_TOOL_VIEW, type DeclaredToolView } from '../src/contract/tool-view';
import {
  defineContract,
  type RuntimeContext,
  withToolView,
} from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';
import { createImplement } from '../src/server/implement';
import { generateOpenApiDocument } from '../src/server/openapi';
import { buildSurfaceManifest } from '../src/testing/surface-manifest';
import { mountAgent } from '../src/tools/agent';
import { createCli } from '../src/tools/cli/create-cli';
import { createToolInvoker } from '../src/tools/invoker';
import { mcpCatalogStamp } from '../src/tools/mcp/catalog';
import { createMcpHandler } from '../src/tools/mcp/handler';
import { buildMcpServer } from '../src/tools/mcp/mount';
import { prepareMcpServerSurface } from '../src/tools/mcp/prepare';
import { implementRemote } from '../src/tools/remote';

/**
 * A view marked as `withToolView` marks it, for endpoints assembled past the
 * types — the runtime half of every rule below is what these tests hold.
 */
function declared(view: Record<string, unknown>): DeclaredToolView {
  return { ...view, [DECLARED_TOOL_VIEW]: true };
}

const Tag = z.object({ id: z.string(), label: z.string() });
const Person = z.object({
  id: z.string(),
  email: z.string(),
  tags: z.array(Tag),
  stats: z.object({ orders: z.number() }).optional(),
});
const PersonList = z.object({ items: z.array(Person) });
const Card = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  orders: z.number().optional(),
});
const CardList = z.object({ items: z.array(Card) });
const PersonSummary = z.object({ id: z.string(), tags: z.array(Tag) });
const ListQuery = z.object({ include: z.array(z.enum(['stats'])).default(['stats']) });

const EVERY_SURFACE = ['HTTP', 'MCP', 'AGENT', 'CLI'] as const;

function peopleContract(cardSchema: z.ZodType<z.input<typeof CardList>> = CardList) {
  return defineContract(
    { prefix: 'people', scope: 'public' },
    {
      list: withToolView(
        {
          method: 'GET',
          path: '/',
          desc: 'List people',
          expose: EVERY_SURFACE,
          input: ListQuery,
          output: PersonList,
          tool: { name: 'people_list' },
        },
        {
          defaults: { include: [] },
          output: cardSchema,
          project: (full, { input }) => ({
            items: full.items.map((person) => ({
              id: person.id,
              tags: person.tags.map((tag) => tag.label),
              ...(input.include.includes('stats') &&
                person.stats && { orders: person.stats.orders }),
            })),
          }),
        },
      ),
      get: withToolView(
        {
          method: 'GET',
          path: '/:id',
          desc: 'Get one person',
          expose: EVERY_SURFACE,
          output: Person,
          tool: { name: 'person_get' },
        },
        { output: PersonSummary },
      ),
    },
  );
}

/** The same endpoints with no view — what HTTP must stay byte-identical to. */
const plainContract = defineContract(
  { prefix: 'people', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List people',
      expose: EVERY_SURFACE,
      input: ListQuery,
      output: PersonList,
      tool: { name: 'people_list' },
    },
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get one person',
      expose: EVERY_SURFACE,
      output: Person,
      tool: { name: 'person_get' },
    },
  },
);

const ADA = {
  id: 'p1',
  email: 'ada@example.test',
  tags: [{ id: 't1', label: 'vip' }],
};

interface Seen {
  source: string;
  include: readonly string[];
}

/** One handler for both contracts; it records what it was asked to load. */
function peopleService(contract: ReturnType<typeof peopleContract> | typeof plainContract) {
  const seen: Seen[] = [];
  const service = implement(contract, {
    list: (ctx) => {
      seen.push({ source: ctx.source, include: [...ctx.input.include] });
      // The expensive part is loaded only when asked for — which is the point
      // of a surface default, and what the spy proves reaches the handler.
      const loadStats = ctx.input.include.includes('stats');
      // A handler that mutates what it was given must not change the next
      // call's default.
      ctx.input.include.push('stats');
      return { items: [{ ...ADA, ...(loadStats && { stats: { orders: 3 } }) }] };
    },
    get: (ctx) => ({ ...ADA, id: ctx.params.id }),
  });
  return { service, seen };
}

async function connect(server: ReturnType<typeof buildMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tool-view-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function http(service: ReturnType<typeof peopleService>['service'], path: string) {
  const handler = createHandler({ services: [service] });
  const res = await handler(new Request(`http://localhost/people${path}`));
  return { status: res.status, body: await res.text() };
}

async function runCli(
  service: ReturnType<typeof peopleService>['service'],
  argv: string[],
): Promise<{ out: string; code: number }> {
  let out = '';
  let code = -1;
  await createCli({
    name: 'people',
    version: '1.0.0',
    services: [service],
    argv,
    stdout: (text) => {
      out += text;
    },
    stderr: () => undefined,
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { out, code };
}

const CARD = { items: [{ id: 'p1', tags: ['vip'] }] };

describe('HTTP keeps the full answer', () => {
  test('the HTTP response and default input are byte-identical to the endpoint without a view', async () => {
    const viewed = peopleService(peopleContract());
    const plain = peopleService(plainContract);
    const withView = await http(viewed.service, '/');
    const withoutView = await http(plain.service, '/');
    expect(withView.status).toBe(200);
    expect(withView.body).toBe(withoutView.body);
    expect(JSON.parse(withView.body)).toEqual({
      items: [{ ...ADA, stats: { orders: 3 } }],
    });
    expect(viewed.seen).toEqual([{ source: 'http', include: ['stats'] }]);
    expect((await http(viewed.service, '/p1')).body).toBe(
      (await http(plain.service, '/p1')).body,
    );
  });

  test('the OpenAPI document does not change', () => {
    const viewed = peopleService(peopleContract()).service;
    const plain = peopleService(plainContract).service;
    const info = { title: 'people', version: '1' };
    expect(JSON.stringify(generateOpenApiDocument({ info, services: [viewed] }))).toBe(
      JSON.stringify(generateOpenApiDocument({ info, services: [plain] })),
    );
  });
});

describe('MCP answers with the view', () => {
  test('the advertised input states the tool default and no longer requires the key', async () => {
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [peopleService(peopleContract()).service],
      }),
    );
    const listed = await client.listTools();
    const list = listed.tools.find((tool) => tool.name === 'people_list');
    const include = z
      .object({ default: z.unknown() })
      .parse(z.record(z.string(), z.unknown()).parse(list?.inputSchema.properties).include);
    expect(include.default).toEqual([]);
    expect(list?.inputSchema.required ?? []).not.toContain('include');
  });

  test('the advertised output schema is the view, not the full record', async () => {
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [peopleService(peopleContract()).service],
      }),
    );
    const listed = await client.listTools();
    const get = listed.tools.find((tool) => tool.name === 'person_get');
    const properties = Object.keys(
      z.record(z.string(), z.unknown()).parse(get?.outputSchema?.properties),
    );
    expect(properties.sort()).toEqual(['id', 'tags']);
  });

  test('a call gets the projected card, and the handler was asked to load nothing', async () => {
    const people = peopleService(peopleContract());
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [people.service],
      }),
    );
    const result = await client.callTool({ name: 'people_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(CARD);
    expect(people.seen).toEqual([{ source: 'mcp', include: [] }]);
  });

  test('an explicit key overrides the tool default', async () => {
    const people = peopleService(peopleContract());
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [people.service],
      }),
    );
    const result = await client.callTool({
      name: 'people_list',
      arguments: { include: ['stats'] },
    });
    expect(result.structuredContent).toEqual({
      items: [{ id: 'p1', tags: ['vip'], orders: 3 }],
    });
    expect(people.seen).toEqual([{ source: 'mcp', include: ['stats'] }]);
  });

  test('a default mutated by one call is fresh for the next', async () => {
    const people = peopleService(peopleContract());
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [people.service],
      }),
    );
    await client.callTool({ name: 'people_list', arguments: {} });
    await client.callTool({ name: 'people_list', arguments: {} });
    expect(people.seen).toEqual([
      { source: 'mcp', include: [] },
      { source: 'mcp', include: [] },
    ]);
  });

  test('a default is copied per call even where the schema passes the value through', async () => {
    // `z.array` rebuilds what it parses, so it would hide a shared default;
    // `z.unknown()` hands the handler the very object the view declared.
    const bags: unknown[] = [];
    const contract = defineContract(
      { prefix: 'bags', scope: 'public' },
      {
        fill: {
          method: 'POST',
          path: '/',
          desc: 'Fill a bag',
          expose: ['MCP'],
          input: z.object({ bag: z.unknown() }),
          output: z.object({ size: z.number() }),
          tool: {
            name: 'bag_fill',
            view: declared({ defaults: { bag: [] }, project: (full: never) => full }),
          },
        },
      },
    );
    const service = implement(contract, {
      fill: (ctx) => {
        const bag = z.array(z.string()).parse(ctx.input.bag);
        bags.push([...bag]);
        if (Array.isArray(ctx.input.bag)) ctx.input.bag.push('used');
        return { size: bag.length };
      },
    });
    const client = await connect(
      buildMcpServer({ serverInfo: { name: 'bags', version: '1' }, services: [service] }),
    );
    const first = await client.callTool({ name: 'bag_fill', arguments: {} });
    const second = await client.callTool({ name: 'bag_fill', arguments: {} });
    expect([first.isError ?? false, second.isError ?? false]).toEqual([false, false]);
    expect(bags).toEqual([[], []]);
    // Advertising the default must not freeze the application's own value.
    expect(Object.isFrozen(contract.endpoints.fill.tool.view.defaults?.bag)).toBe(false);
  });

  test('a default beside a referenced schema is still visible to the model', async () => {
    const Tags = z.array(z.string()).meta({ id: 'Tags' });
    const contract = defineContract(
      { prefix: 'refs', scope: 'public' },
      {
        find: {
          method: 'POST',
          path: '/',
          desc: 'Find by tags',
          expose: ['MCP'],
          input: z.object({ tags: Tags }),
          output: z.object({ n: z.number() }),
          tool: {
            name: 'refs_find',
            view: declared({ defaults: { tags: [] }, project: (full: never) => full }),
          },
        },
      },
    );
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'refs', version: '1' },
        services: [implement(contract, { find: (ctx) => ({ n: ctx.input.tags.length }) })],
      }),
    );
    const listed = await client.listTools();
    const tags = z
      .record(z.string(), z.unknown())
      .parse(
        z.record(z.string(), z.unknown()).parse(listed.tools[0]?.inputSchema.properties).tags,
      );
    expect(tags.default).toEqual([]);
    expect(Array.isArray(tags.allOf)).toBe(true);
    expect('$ref' in tags).toBe(false);
  });

  test('a view without project slices the full record by its schema', async () => {
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [peopleService(peopleContract()).service],
      }),
    );
    const result = await client.callTool({ name: 'person_get', arguments: { id: 'p9' } });
    expect(result.structuredContent).toEqual({ id: 'p9', tags: ADA.tags });
  });

  test('changing the view moves the catalog digest', () => {
    const before = mcpCatalogStamp(
      prepareMcpServerSurface({ services: [peopleService(peopleContract()).service] }),
    );
    const after = mcpCatalogStamp(
      prepareMcpServerSurface({
        services: [
          peopleService(peopleContract(CardList.extend({ note: z.string().optional() })))
            .service,
        ],
      }),
    );
    expect(after.digest).not.toBe(before.digest);
  });
});

describe('AGENT and CLI answer with the view; the invoker does not', () => {
  test('an agent tool returns the card and the handler loads nothing', async () => {
    const people = peopleService(peopleContract());
    const tools = mountAgent([people.service]);
    const execute = tools.people_list?.execute;
    if (!execute) throw new Error('people_list is not mounted');
    // A contract tool's input is typed `never` on the AI SDK side; the call
    // passes exactly what a model would send — nothing.
    const result = await Reflect.apply(execute, undefined, [
      {},
      { toolCallId: 'call-1', messages: [], context: undefined },
    ]);
    expect(result).toEqual(CARD);
    expect(people.seen).toEqual([{ source: 'agent', include: [] }]);
  });

  test('a CLI command prints the card and the handler loads nothing', async () => {
    const people = peopleService(peopleContract());
    const { out, code } = await runCli(people.service, ['people_list', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(CARD);
    expect(people.seen).toEqual([{ source: 'cli', include: [] }]);
  });

  test('an invoker backing a model-facing transport opts into the tool surface', async () => {
    const people = peopleService(peopleContract());
    const invoker = createToolInvoker(people.service, { transport: 'MCP', toolSurface: true });
    expect(await invoker.invoke('people_list', {}, { source: 'mcp' })).toEqual({
      ok: true,
      data: CARD,
    });
    expect(people.seen).toEqual([{ source: 'mcp', include: [] }]);
  });

  test('the agent tool advertises the tool default', () => {
    const tools = mountAgent([peopleService(peopleContract()).service]);
    const schema = JSON.stringify(tools.people_list?.inputSchema);
    expect(schema).toContain('"default":[]');
  });

  test('the in-process invoker gets the full answer — code, not a model, is calling', async () => {
    const people = peopleService(peopleContract());
    const invoker = createToolInvoker(people.service, { transport: 'AGENT' });
    const result = await invoker.invoke('people_list', {});
    expect(result).toEqual({ ok: true, data: { items: [{ ...ADA, stats: { orders: 3 } }] } });
    expect(people.seen).toEqual([{ source: 'internal', include: ['stats'] }]);
  });
});

describe('a projection is held to its own schema', () => {
  function failing(project: () => unknown) {
    const contract = defineContract(
      { prefix: 'broken', scope: 'public' },
      {
        read: {
          method: 'GET',
          path: '/',
          desc: 'Read the thing',
          expose: ['MCP'],
          output: Person,
          tool: { name: 'broken_read', view: declared({ output: PersonSummary, project }) },
        },
      },
    );
    return implement(contract, { read: () => ADA });
  }

  test('a projection that breaks the view schema is a server fault', async () => {
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'broken', version: '1' },
        services: [failing(() => ({ id: 42 }))],
      }),
    );
    const result = await client.callTool({ name: 'broken_read', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('INTERNAL_SERVER_ERROR');
  });

  test('a projection that throws is a server fault whatever it threw, and the cause is kept', async () => {
    const thrown: unknown[] = [];
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'broken', version: '1' },
        services: [
          failing(() => {
            throw new Error('lookup in a projection');
          }),
        ],
        hooks: { onToolError: ({ error }) => void thrown.push(error) },
      }),
    );
    const result = await client.callTool({ name: 'broken_read', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('INTERNAL_SERVER_ERROR');
    const failure = z.instanceof(Error).parse(thrown[0]);
    expect(z.instanceof(Error).parse(failure.cause).message).toBe('lookup in a projection');
  });

  test('a rejected asynchronous projection is refused without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', listen);
    try {
      const client = await connect(
        buildMcpServer({
          serverInfo: { name: 'broken', version: '1' },
          services: [failing(async () => Promise.reject(new Error('late failure')))],
        }),
      );
      const result = await client.callTool({ name: 'broken_read', arguments: {} });
      expect(result.isError).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listen);
    }
  });

  test('a projection that returns nothing is named as the projection, not the handler', async () => {
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'broken', version: '1' },
        services: [failing(() => undefined)],
      }),
    );
    const result = await client.callTool({ name: 'broken_read', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('toolView.project returned undefined');
  });

  test('an asynchronous projection is refused', async () => {
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'broken', version: '1' },
        services: [failing(async () => ({ id: 'p1', tags: [] }))],
      }),
    );
    const result = await client.callTool({ name: 'broken_read', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('synchronous');
  });

  test('a slice is not reported as a strip; keys a projection returns beyond its schema are', async () => {
    const stripped: string[][] = [];
    const extra = defineContract(
      { prefix: 'extra', scope: 'public' },
      {
        sliced: {
          method: 'GET',
          path: '/s',
          desc: 'Sliced',
          expose: ['MCP'],
          output: Person,
          tool: { name: 'extra_sliced', view: declared({ output: PersonSummary }) },
        },
        projected: {
          method: 'GET',
          path: '/p',
          desc: 'Projected',
          expose: ['MCP'],
          output: Person,
          tool: {
            name: 'extra_projected',
            view: declared({
              output: PersonSummary,
              project: () => ({ id: 'p1', tags: [], leaked: true }),
            }),
          },
        },
      },
    );
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'extra', version: '1' },
        services: [implement(extra, { sliced: () => ADA, projected: () => ADA })],
        onOutputStrip: (_tool, paths) => void stripped.push(paths),
      }),
    );
    await client.callTool({ name: 'extra_sliced', arguments: {} });
    expect(stripped).toEqual([]);
    await client.callTool({ name: 'extra_projected', arguments: {} });
    expect(stripped).toEqual([['leaked']]);
  });
});

describe('a view composes with the rest of the tool machinery', () => {
  test('an elicitation guard pass runs with a view and the completed call answers with it', async () => {
    const KEY = '0123456789abcdef0123456789abcdef';
    const contract = defineContract(
      { prefix: 'guarded', scope: 'admin' },
      {
        remove: {
          method: 'DELETE',
          path: '/:id',
          desc: 'Remove a person',
          expose: ['MCP'],
          params: z.object({ id: z.string() }),
          output: Person,
          tool: {
            view: declared({ output: PersonSummary }),
            name: 'person_remove',
            mcp: {
              inputRequired: [
                { key: 'confirm', message: 'Remove?', schema: z.object({ yes: z.boolean() }) },
              ],
            },
          },
        },
      },
    );
    const service = createImplement<RuntimeContext & { identity: string }>()(contract, {
      remove: (ctx) => ({ ...ADA, id: ctx.params.id }),
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'guarded', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });
    const call = (extra: Record<string, unknown>) =>
      handler.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: 'alpha',
            'content-type': 'application/json',
            'mcp-method': 'tools/call',
            'mcp-name': 'person_remove',
            'mcp-protocol-version': '2026-07-28',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'person_remove',
              arguments: { id: 'p7' },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'guard-test', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
              },
              ...extra,
            },
          }),
        }),
      );
    const Result = z.object({ result: z.record(z.string(), z.unknown()) });
    const first = Result.parse(await (await call({})).json()).result;
    expect(first.resultType).toBe('input_required');
    const second = Result.parse(
      await (
        await call({
          requestState: first.requestState,
          inputResponses: { confirm: { action: 'accept', content: { yes: true } } },
        })
      ).json(),
    ).result;
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toEqual({ id: 'p7', tags: ADA.tags });
    await handler.close();
  });

  test('afterToolCall records the answer the caller received', async () => {
    const answers: unknown[] = [];
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [peopleService(peopleContract()).service],
        hooks: { afterToolCall: ({ result }) => void answers.push(result) },
      }),
    );
    await client.callTool({ name: 'people_list', arguments: {} });
    expect(answers).toEqual([{ ok: true, data: CARD }]);
  });

  test('an elicitation resolver sees the view defaults the handler will see', async () => {
    const asked: unknown[] = [];
    const contract = defineContract(
      { prefix: 'asking', scope: 'admin' },
      {
        list: {
          method: 'POST',
          path: '/',
          desc: 'List after deciding what to ask',
          expose: ['MCP'],
          input: z.object({ include: z.array(z.string()).default(['all']) }),
          output: z.object({ n: z.number() }),
          tool: {
            view: declared({ defaults: { include: [] }, project: (full: never) => full }),
            name: 'asking_list',
            mcp: {
              inputRequired: ({ input }) => {
                asked.push(input);
                return [];
              },
            },
          },
        },
      },
    );
    const service = createImplement<RuntimeContext & { identity: string }>()(contract, {
      list: (ctx) => ({ n: ctx.input.include.length }),
    });
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'asking', version: '1' },
        services: [service],
        multiRound: {
          state: { key: '0123456789abcdef0123456789abcdef', principal: () => 'alpha' },
        },
      }),
    );
    const result = await client.callTool({ name: 'asking_list', arguments: {} });
    expect(result.structuredContent).toEqual({ n: 0 });
    expect(asked).toEqual([{ include: [] }]);
  });

  test('a proxy applies the defaults and the projection locally', async () => {
    const people = peopleService(peopleContract());
    const origin = createHandler({ services: [people.service] });
    const remote = implementRemote(
      peopleContract(),
      createHttpClient({
        baseUrl: 'http://origin.test',
        fetch: (input, init) => origin(new Request(input, init)),
      }),
    );
    const client = await connect(
      buildMcpServer({ serverInfo: { name: 'proxy', version: '1' }, services: [remote] }),
    );
    const result = await client.callTool({ name: 'people_list', arguments: {} });
    expect(result.structuredContent).toEqual(CARD);
    // The proxy parsed `include: []` and projected with it, but a GET query has
    // no form for an empty array: the origin saw no `include` and applied its
    // own HTTP default. The answer is right; the origin's saving is not made.
    expect(people.seen).toEqual([{ source: 'http', include: ['stats'] }]);
  });

  test('implementRemote carries the view, so a proxy projects locally', async () => {
    const origin = createHandler({ services: [peopleService(peopleContract()).service] });
    const remote = implementRemote(
      peopleContract(),
      createHttpClient({
        baseUrl: 'http://origin.test',
        fetch: (input, init) => origin(new Request(input, init)),
      }),
    );
    expect(remote.methods.list?.toolView).toBeDefined();
    const client = await connect(
      buildMcpServer({ serverInfo: { name: 'proxy', version: '1' }, services: [remote] }),
    );
    const result = await client.callTool({ name: 'person_get', arguments: { id: 'p2' } });
    expect(result.structuredContent).toEqual({ id: 'p2', tags: ADA.tags });
  });

  test('implementRemote never mounts a proxied stream as a tool', () => {
    const contract = defineContract(
      { prefix: 'feed', scope: 'public' },
      {
        watch: {
          method: 'GET',
          path: '/watch',
          desc: 'Watch the feed',
          stream: { item: z.object({ n: z.number() }) },
        },
      },
    );
    const remote = implementRemote(
      contract,
      createHttpClient({ baseUrl: 'http://localhost' }),
    );
    expect(remote.methods.watch?.expose).toEqual(['HTTP']);
    expect(createToolInvoker(remote, { transport: 'MCP' }).names).toEqual([]);
  });

  test('implementRemote asks no elicitation questions whose answers it could not forward', () => {
    const contract = defineContract(
      { prefix: 'asks', scope: 'public' },
      {
        act: {
          method: 'POST',
          path: '/',
          desc: 'Act after asking',
          expose: ['MCP'],
          tool: {
            mcp: {
              inputRequired: [
                { key: 'ok', message: 'Sure?', schema: z.object({ ok: z.boolean() }) },
              ],
            },
          },
        },
      },
    );
    const remote = implementRemote(
      contract,
      createHttpClient({ baseUrl: 'http://localhost' }),
    );
    expect(remote.methods.act?.mcp).toBeUndefined();
  });
});

describe('the surface snapshot records a view only where one is declared', () => {
  test('an operation with a view carries it; one without does not grow a key', () => {
    const manifest = buildSurfaceManifest({
      services: [peopleService(peopleContract()).service],
    });
    const byAction = new Map(
      manifest.operations.map((operation) => [operation.action, operation]),
    );
    expect(byAction.get('list')?.toolView).toMatchObject({ project: true });
    expect(byAction.get('list')?.toolView?.defaults).toEqual(expect.any(String));
    expect(byAction.get('get')?.toolView).toEqual({
      defaults: null,
      output: expect.any(String),
      project: false,
    });
    const plain = buildSurfaceManifest({ services: [peopleService(plainContract).service] });
    for (const operation of plain.operations) expect('toolView' in operation).toBe(false);
  });

  test('changing the view output moves the snapshot', () => {
    const before = buildSurfaceManifest({
      services: [peopleService(peopleContract()).service],
    });
    const after = buildSurfaceManifest({
      services: [
        peopleService(peopleContract(CardList.extend({ note: z.string().optional() })))
          .service,
      ],
    });
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });
});

describe('a view of defaults alone changes the call, not the answer', () => {
  // The most common view: a model needs a lighter call, and the answer keeps
  // its one shape. It used to need the endpoint's own output repeated beside
  // the defaults, which read as "a different answer here" where there is none.
  const lighter = defineContract(
    { prefix: 'people', scope: 'public' },
    {
      list: withToolView(
        {
          method: 'GET',
          path: '/',
          desc: 'List people',
          expose: EVERY_SURFACE,
          input: ListQuery,
          output: PersonList,
          tool: { name: 'people_list' },
        },
        { defaults: { include: [] } },
      ),
    },
  );
  const FULL = { items: [ADA] };

  function lighterService() {
    const seen: Seen[] = [];
    const service = implement(lighter, {
      list: (ctx) => {
        seen.push({ source: ctx.source, include: [...ctx.input.include] });
        const loadStats = ctx.input.include.includes('stats');
        return { items: [{ ...ADA, ...(loadStats && { stats: { orders: 3 } }) }] };
      },
    });
    return { service, seen };
  }

  test('a tool call gets the default and the full answer; HTTP keeps the schema default', async () => {
    const people = lighterService();
    const tools = mountAgent([people.service]);
    const execute = tools.people_list?.execute;
    if (!execute) throw new Error('people_list is not mounted');
    const result = await Reflect.apply(execute, undefined, [
      {},
      { toolCallId: 'call-1', messages: [], context: undefined },
    ]);
    expect(PersonList.parse(result)).toEqual(FULL);
    expect(result).toEqual(FULL);
    const viaHttp = await http(people.service, '/');
    expect(viaHttp.status).toBe(200);
    expect(PersonList.parse(JSON.parse(viaHttp.body))).toEqual({
      items: [{ ...ADA, stats: { orders: 3 } }],
    });
    expect(people.seen).toEqual([
      { source: 'agent', include: [] },
      { source: 'http', include: ['stats'] },
    ]);
  });

  test('the advertised output is the full one, and the input states the default', async () => {
    const client = await connect(
      buildMcpServer({
        serverInfo: { name: 'people', version: '1' },
        services: [lighterService().service],
      }),
    );
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === 'people_list');
    expect(JSON.stringify(tool?.inputSchema)).toContain('"default":[]');
    expect(tool?.outputSchema).toEqual(
      expect.objectContaining({ required: ['items'], type: 'object' }),
    );
  });

  test('the snapshot records the defaults and no separate answer schema', () => {
    const manifest = buildSurfaceManifest({ services: [lighterService().service] });
    expect(manifest.operations[0]?.toolView).toEqual({
      defaults: expect.any(String),
      output: null,
      project: false,
    });
  });
});

describe('a view is refused where it cannot mean anything', () => {
  const output = z.object({ ok: z.boolean() });
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      'an HTTP-only endpoint',
      { expose: ['HTTP'], output, tool: { view: declared({ output }) } },
      /not exposed on any tool transport/,
    ],
    [
      'an endpoint without a full output',
      { tool: { view: declared({ output }) } },
      /needs the endpoint's full output/,
    ],
    [
      'a view that changes nothing',
      { output, tool: { view: declared({}) } },
      /declares no defaults, output or project/,
    ],
    [
      'a view whose defaults are empty',
      { output, tool: { view: declared({ defaults: {} }) } },
      /declares no defaults, output or project/,
    ],
    [
      'a default for a key the input does not have',
      {
        output,
        input: z.object({ q: z.string() }),
        tool: { view: declared({ output, defaults: { nope: 1 } }) },
      },
      /defaults\.nope is not a key/,
    ],
    [
      'a default for a path param',
      {
        path: '/:id',
        output,
        input: z.object({ q: z.string() }),
        tool: { view: declared({ output, defaults: { id: 'x' } }) },
      },
      /defaults\.id is a path param/,
    ],
    [
      'a default the input would reject',
      {
        output,
        input: z.object({ n: z.number() }),
        tool: { view: declared({ output, defaults: { n: 'x' } }) },
      },
      /defaults\.n is not a valid value/,
    ],
    [
      'a raw response',
      { rawResponse: true, tool: { view: declared({ output }) } },
      /cannot set tool options — it never reaches a tool transport/,
    ],
    [
      'a rawBody endpoint',
      {
        method: 'POST',
        rawBody: true,
        input: z.object({ a: z.string() }),
        output,
        tool: { view: declared({ output }) },
      },
      /cannot set tool options — it never reaches a tool transport/,
    ],
    [
      'a responseMeta endpoint',
      { output, responseMeta: { status: 201 }, tool: { view: declared({ output }) } },
      /cannot set tool options — it never reaches a tool transport/,
    ],
    [
      'a multipart endpoint',
      {
        method: 'POST',
        multipart: { files: { file: {} } },
        output,
        tool: { view: declared({ output }) },
      },
      /HTTP-only by kind/,
    ],
    [
      'a streaming endpoint',
      { stream: { item: output }, tool: { view: declared({ output }) } },
      /cannot set tool options — it never reaches a tool transport/,
    ],
    [
      'a view written as a bare object instead of through withToolView',
      { output, tool: { view: { output } } },
      /must be declared with withToolView/,
    ],
    [
      'a view left at the top level, where 0.93 read it',
      { output, toolView: declared({ output }) },
      /sets `toolView` — tool options live in `tool`/,
    ],
    [
      // Half-migrated: moved into the group under its old name. Ignoring it
      // would rename the tool silently, one level down from the case above.
      'an old option name inside the group',
      {
        output,
        expose: ['MCP'],
        tool: { annotations: { readOnlyHint: true }, toolName: 'x' },
      },
      /sets `tool\.toolName`, which is not a tool option/,
    ],
    [
      'a key the group does not have',
      { output, expose: ['MCP'], tool: { readOnlyHint: true } },
      /sets `tool\.readOnlyHint`, which is not a tool option/,
    ],
    [
      'a project that is not a function',
      { output, tool: { view: declared({ project: 'no' }) } },
      /project must be a function/,
    ],
  ];
  for (const [name, fields, message] of cases) {
    test(name, () => {
      expect(() =>
        defineContract(
          { prefix: 'refused' },
          // Assembled past the types on purpose: this is the runtime half of the rule.
          {
            bad: Object.assign({ method: 'GET' as const, path: '/', desc: 'Refused' }, fields),
          },
        ),
      ).toThrow(message);
    });
  }
});
