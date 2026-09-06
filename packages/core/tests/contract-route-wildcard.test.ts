import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createHandler, implement } from '../src/server';
import {
  allowedMethods,
  buildRouteMap,
  findShadowedRoutes,
  matchRoute,
} from '../src/server/router';

const SlugParamsSchema = z.object({ slug: z.string() });
const WildcardParamsSchema = z.object({ slug: z.string(), filePath: z.string() });
const MatchSchema = z.object({ route: z.string(), slug: z.string(), remainder: z.string() });

const appContract = defineContract(
  { prefix: 'app' },
  {
    // Deliberately declared first: route sorting, not declaration order, must
    // keep the catch-all behind the more specific endpoints below.
    fallback: {
      method: 'GET',
      path: '/:slug/*filePath',
      desc: 'Catch nested app paths',
      params: WildcardParamsSchema,
      output: MatchSchema,
    },
    page: {
      method: 'GET',
      path: '/:slug/page',
      desc: 'Get the app page',
      params: SlugParamsSchema,
      output: MatchSchema,
    },
    shell: {
      method: 'GET',
      path: '/:slug',
      desc: 'Get the app shell',
      params: SlugParamsSchema,
      output: MatchSchema,
    },
  },
);

const appService = implement(appContract, {
  fallback: ({ params }) => ({
    route: 'fallback',
    slug: params.slug,
    remainder: params.filePath,
  }),
  page: ({ params }) => ({ route: 'page', slug: params.slug, remainder: '' }),
  shell: ({ params }) => ({ route: 'shell', slug: params.slug, remainder: '' }),
});

const routeMap = buildRouteMap([{ prefix: '', service: appService }]);

describe('contract route — trailing wildcard matcher', () => {
  test('captures one or many trailing segments', () => {
    expect(matchRoute(routeMap, 'GET', '/app/foo/page/deep')?.pathParams).toEqual({
      slug: 'foo',
      filePath: 'page/deep',
    });
    expect(matchRoute(routeMap, 'GET', '/app/foo/a/b')?.pathParams).toEqual({
      slug: 'foo',
      filePath: 'a/b',
    });
  });

  test('specific routes win and the bare prefix reaches the exact shell', () => {
    expect(matchRoute(routeMap, 'GET', '/app/foo/page')?.method.key).toBe('page');
    expect(matchRoute(routeMap, 'GET', '/app/foo')?.method.key).toBe('shell');
  });

  test('a wildcard alone accepts an empty remainder but not a short prefix', () => {
    const wildcardOnly = buildRouteMap([
      {
        prefix: '',
        service: implement(
          defineContract(
            { prefix: 'app' },
            {
              fallback: {
                method: 'GET',
                path: '/:slug/*filePath',
                desc: 'Catch all',
                params: WildcardParamsSchema,
              },
            },
          ),
          { fallback: () => undefined },
        ),
      },
    ]);
    expect(matchRoute(wildcardOnly, 'GET', '/app/foo')?.pathParams).toEqual({
      slug: 'foo',
      filePath: '',
    });
    expect(matchRoute(wildcardOnly, 'GET', '/app')).toBeNull();
  });

  test('allowedMethods uses the same wildcard semantics', () => {
    expect(allowedMethods(routeMap, '/app/foo/a/b')).toEqual(['GET']);
  });

  test('shadow diagnostics probe a real nested path for a contract wildcard', () => {
    const shadowed = findShadowedRoutes(routeMap, [
      { method: 'GET', path: '/app/:slug/*filePath', handler: () => new Response('raw') },
    ]);
    expect(shadowed.map((entry) => entry.endpoint)).toContain('app.fallback');
  });
});

describe('contract route — full HTTP pipeline', () => {
  const lifecycleCalls: string[] = [];
  const handler = createHandler({
    services: [appService],
    hooks: {
      beforeHandle: (_context, endpoint) => {
        lifecycleCalls.push(endpoint.key);
      },
    },
  });

  test('validates wildcard params and runs lifecycle before the handler', async () => {
    const response = await handler(new Request('http://local/app/foo/a/b'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      route: 'fallback',
      slug: 'foo',
      remainder: 'a/b',
    });
    expect(lifecycleCalls).toEqual(['fallback']);
  });

  test('a wrong method returns 405 with Allow instead of 404', async () => {
    const response = await handler(
      new Request('http://local/app/foo/a/b', { method: 'POST' }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });
});

describe('contract route — raw response endpoint', () => {
  const rawContract = defineContract(
    { prefix: 'assets' },
    {
      fallback: {
        method: 'GET',
        path: '/:slug/*filePath',
        desc: 'Serve nested asset bytes',
        params: WildcardParamsSchema,
        rawResponse: true,
        contentType: 'text/plain',
      },
    },
  );
  const rawHandler = createHandler({
    services: [
      implement(rawContract, {
        fallback: ({ params }) => new Response(`${params.slug}:${params.filePath}`),
      }),
    ],
  });

  test('keeps wildcard matching inside the gated contract response pipeline', async () => {
    const response = await rawHandler(new Request('http://local/assets/foo/a/b'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('foo:a/b');
  });
});

describe('named wildcard contract validation', () => {
  const endpoint = (path: string, params?: z.ZodType) => ({
    method: 'GET' as const,
    path,
    desc: 'Wildcard validation probe',
    params,
  });

  test('rejects bare, invalid, non-terminal and duplicate wildcard names', () => {
    expect(() =>
      defineContract({ prefix: 'bad' }, { route: endpoint('/*', z.object({})) }),
    ).toThrow('must be named');
    expect(() =>
      defineContract(
        { prefix: 'bad' },
        { route: endpoint('/*file-path', z.object({ 'file-path': z.string() })) },
      ),
    ).toThrow('Invalid wildcard name "file-path"');
    expect(() =>
      defineContract(
        { prefix: 'bad' },
        { route: endpoint('/*filePath/tail', z.object({ filePath: z.string() })) },
      ),
    ).toThrow('must be the final segment');
    expect(() =>
      defineContract(
        { prefix: 'bad' },
        { route: endpoint('/:filePath/*filePath', z.object({ filePath: z.string() })) },
      ),
    ).toThrow('Duplicate route parameter name');
  });

  test('infers a wildcard schema and requires explicit schemas to cover it', () => {
    const inferred = defineContract({ prefix: 'good' }, { route: endpoint('/*filePath') })
      .endpoints.route.params;
    expect(inferred?.parse({ filePath: 'nested/path' })).toEqual({ filePath: 'nested/path' });
    expect(() =>
      defineContract(
        { prefix: 'bad' },
        { route: endpoint('/*filePath', z.object({ other: z.string() })) },
      ),
    ).toThrow('is missing wildcard field "filePath"');
  });
  test('a malformed percent-escape in the path answers the 404 envelope, not a bare URIError', async () => {
    const contract = defineContract(
      { prefix: 'esc' },
      {
        one: {
          method: 'GET',
          path: '/items/:id',
          desc: 'd',
          expose: ['HTTP'],
          output: z.object({ id: z.string() }),
        },
        tree: {
          method: 'GET',
          path: '/files/*filePath',
          desc: 'd',
          expose: ['HTTP'],
          output: z.object({ path: z.string() }),
        },
      },
    );
    const handler = createHandler({
      services: [
        implement(contract, {
          one: async ({ params }) => ({ id: params.id }),
          tree: async ({ params }) => ({ path: params.filePath }),
        }),
      ],
    });
    for (const path of ['/esc/items/%E0%A4%A', '/esc/files/a/%ZZ']) {
      const res = await handler(new Request(`http://x${path}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(res.headers.get('x-request-id')).toBeTruthy();
    }
    const ok = await handler(new Request('http://x/esc/items/a%20b'));
    expect(await ok.json()).toEqual({ id: 'a b' });
  });
});
