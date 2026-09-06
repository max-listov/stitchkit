import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { defineContract, type PathParams } from '../src/contract/define';
import { createHandler, type Handlers, implement } from '../src/server';
import { generateOpenApiDocument } from '../src/server/openapi';
import { buildSurfaceManifest } from '../src/testing/surface-manifest';
import { collectTools, createToolRunner } from '../src/tools/mount';

const VisitorSchema = z.object({ visitorKey: z.string() });
const visitors = defineContract(
  { prefix: 'visitors' },
  {
    read: {
      method: 'GET',
      path: '/:visitorKey',
      desc: 'Read one visitor',
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
      output: VisitorSchema,
    },
  },
);

const service = implement(visitors, {
  read: ({ params }) => {
    const visitorKey: string = params.visitorKey;
    return { visitorKey };
  },
});

function compileTimePathParams(): void {
  const params: PathParams<'/projects/:projectId/files/*filePath'> = {
    projectId: 'p1',
    filePath: 'one/two',
  };
  void params;

  const api = createClient(visitors, { baseUrl: 'http://stitchkit.test' });
  void api.read({ visitorKey: 'v1' });
  // @ts-expect-error — the route literal makes its path key required.
  void api.read();
  // @ts-expect-error — undeclared path keys cannot replace the literal key.
  void api.read({ id: 'v1' });
}
void compileTimePathParams;

describe('path-literal params', () => {
  test('materializes one schema for HTTP dispatch and the generated client', async () => {
    const handler = createHandler({ services: [service] });
    const api = createClient(visitors, {
      baseUrl: 'http://stitchkit.test',
      fetch: (input, init) => handler(new Request(input, init)),
    });

    await expect(api.read({ visitorKey: 'visitor one' })).resolves.toEqual({
      visitorKey: 'visitor one',
    });
    expect(service.methods.read?.paramsSchema?.parse({ visitorKey: 'v2' })).toEqual({
      visitorKey: 'v2',
    });
  });

  test('projects inferred params into OpenAPI and the surface manifest', () => {
    const document = generateOpenApiDocument({
      info: { title: 'Visitors', version: '1' },
      services: [service],
    });
    const operation = document.paths['/visitors/{visitorKey}']?.get;
    expect(operation).toMatchObject({
      parameters: [
        {
          name: 'visitorKey',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
    });

    const manifest = buildSurfaceManifest({ services: [service] });
    expect(manifest.operations[0]?.schemas.params).not.toBeNull();
    expect(
      manifest.toolSurfaces.map((surface) => ({
        transport: surface.transport,
        tools: surface.tools.map((tool) => tool.name),
      })),
    ).toEqual([
      { transport: 'AGENT', tools: ['read_visitor'] },
      { transport: 'CLI', tools: ['read_visitor'] },
      { transport: 'MCP', tools: ['read_visitor'] },
    ]);
  });

  test('executes inferred params through MCP, Agent and CLI projections', async () => {
    for (const transport of ['MCP', 'AGENT', 'CLI'] as const) {
      const [tool] = collectTools(service, transport);
      if (!tool) throw new Error(`missing ${transport} projection`);
      expect(() => tool.argumentSchema.parse({})).toThrow();
      expect(tool.argumentSchema.parse({ visitorKey: 'v1' })).toEqual({ visitorKey: 'v1' });
      const result = await createToolRunner({
        source: transport.toLowerCase() as 'mcp' | 'agent' | 'cli',
      })(tool, { visitorKey: 'v1' });
      expect(result).toEqual({ ok: true, data: { visitorKey: 'v1' } });
    }
  });

  test('keeps explicit coercion and rejects every uncovered path key', () => {
    const explicit = defineContract(
      { prefix: 'jobs' },
      {
        read: {
          method: 'GET',
          path: '/:jobId/attempts/:attempt',
          desc: 'Read an attempt',
          params: z.object({ jobId: z.uuid(), attempt: z.coerce.number().int() }),
        },
      },
    );
    expect(
      explicit.endpoints.read.params?.parse({
        jobId: 'e9137cc1-8dcb-4628-8495-5fc73dc743d2',
        attempt: '3',
      }),
    ).toEqual({
      jobId: 'e9137cc1-8dcb-4628-8495-5fc73dc743d2',
      attempt: 3,
    });

    expect(() =>
      defineContract(
        { prefix: 'jobs' },
        {
          read: {
            method: 'GET',
            path: '/:jobId/attempts/:attempt',
            desc: 'Read an attempt',
            params: z.object({ jobId: z.string() }),
          },
        },
      ),
    ).toThrow('missing path field "attempt"');
  });
  test('coverage is judged by property names, so unrepresentable fields are fine', () => {
    const contract = defineContract(
      { prefix: 'cover' },
      {
        byDate: {
          method: 'GET',
          path: '/at/:day',
          desc: 'd',
          expose: ['HTTP'],
          params: z.object({ day: z.coerce.date() }),
        },
      },
    );
    expect(contract.endpoints.byDate?.params).toBeDefined();
  });

  test('a params schema without properties is refused by name, not as a missing field', () => {
    expect(() =>
      defineContract(
        { prefix: 'cover' },
        {
          rec: {
            method: 'GET',
            path: '/r/:id',
            desc: 'd',
            expose: ['HTTP'],
            params: z.record(z.string(), z.string()),
          },
        },
      ),
    ).toThrow('must be an object schema with a property per path field');
  });

  test('a required params field the path never supplies is refused; an optional one is not', () => {
    const endpoint = (params: z.ZodType) => ({
      method: 'GET' as const,
      path: '/x/:id',
      desc: 'd',
      expose: ['HTTP'] as const,
      params,
    });
    expect(() =>
      defineContract(
        { prefix: 'cover' },
        { strict: endpoint(z.object({ id: z.string(), extra: z.string() })) },
      ),
    ).toThrow('requires field "extra" that the path does not carry');
    expect(
      defineContract(
        { prefix: 'cover' },
        { loose: endpoint(z.object({ id: z.string(), extra: z.string().optional() })) },
      ).endpoints.loose,
    ).toBeDefined();
  });

  test('Handlers<C> with its default context types inferred params on a segment path', async () => {
    const contract = defineContract(
      { prefix: 'typed' },
      {
        read: {
          method: 'GET',
          path: '/items/:id',
          desc: 'd',
          expose: ['HTTP'],
          output: z.object({ id: z.string() }),
        },
      },
    );
    // Compile-time: with `HandlerContext` as the default the intersection was
    // `undefined & { id: string }` — `never` — and `ctx.params.id` did not type.
    const handlers: Handlers<typeof contract.endpoints> = {
      read: async (ctx) => ({ id: ctx.params.id }),
    };
    const handler = createHandler({ services: [implement(contract, handlers)] });
    const res = await handler(new Request('http://x/typed/items/7'));
    expect(await res.json()).toEqual({ id: '7' });
  });
});
