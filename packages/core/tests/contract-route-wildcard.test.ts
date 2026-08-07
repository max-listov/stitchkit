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
const WildcardParamsSchema = z.object({ slug: z.string(), '*': z.string() });
const MatchSchema = z.object({ route: z.string(), slug: z.string(), remainder: z.string() });

const appContract = defineContract(
  { prefix: 'app' },
  {
    // Deliberately declared first: route sorting, not declaration order, must
    // keep the catch-all behind the more specific endpoints below.
    fallback: {
      method: 'GET',
      path: '/:slug/*',
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
    remainder: params['*'],
  }),
  page: ({ params }) => ({ route: 'page', slug: params.slug, remainder: '' }),
  shell: ({ params }) => ({ route: 'shell', slug: params.slug, remainder: '' }),
});

const routeMap = buildRouteMap([{ prefix: '', service: appService }]);

describe('contract route — trailing wildcard matcher', () => {
  test('captures one or many trailing segments', () => {
    expect(matchRoute(routeMap, 'GET', '/app/foo/page/deep')?.pathParams).toEqual({
      slug: 'foo',
      '*': 'page/deep',
    });
    expect(matchRoute(routeMap, 'GET', '/app/foo/a/b')?.pathParams).toEqual({
      slug: 'foo',
      '*': 'a/b',
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
                path: '/:slug/*',
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
      '*': '',
    });
    expect(matchRoute(wildcardOnly, 'GET', '/app')).toBeNull();
  });

  test('allowedMethods uses the same wildcard semantics', () => {
    expect(allowedMethods(routeMap, '/app/foo/a/b')).toEqual(['GET']);
  });

  test('shadow diagnostics probe a real nested path for a contract wildcard', () => {
    const shadowed = findShadowedRoutes(routeMap, [
      { method: 'GET', path: '/app/:slug/*', handler: () => new Response('raw') },
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
        path: '/:slug/*',
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
        fallback: ({ params }) => new Response(`${params.slug}:${params['*']}`),
      }),
    ],
  });

  test('keeps wildcard matching inside the gated contract response pipeline', async () => {
    const response = await rawHandler(new Request('http://local/assets/foo/a/b'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('foo:a/b');
  });
});
