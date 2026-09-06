import { describe, expect, test } from 'bun:test';
import { createHandler } from '../src/server/create';
import type { RawRoute } from '../src/server/types';

const handler = () => new Response('ok');

function route(method: RawRoute['method'], path: string): RawRoute {
  return { method, path, handler };
}

describe('raw route ambiguity validation', () => {
  test('rejects incomplete or empty observability identity', () => {
    expect(() =>
      createHandler({
        rawRoutes: [
          { method: 'GET', path: '/empty', serviceName: ' ', handler: () => new Response() },
        ],
      }),
    ).toThrow('has an empty serviceName');
    expect(() =>
      createHandler({
        rawRoutes: [
          { method: 'GET', path: '/action', action: 'read', handler: () => new Response() },
        ],
      }),
    ).toThrow('declares action without serviceName');
  });

  test.each([
    {
      name: 'exact duplicate',
      routes: [route('GET', '/users'), route('GET', '/users')],
      message: 'GET /users duplicates earlier GET /users',
    },
    {
      name: 'equivalent parameter names',
      routes: [route('GET', '/users/:id'), route('GET', '/users/:userId')],
      message: 'GET /users/:userId has the same parameter shape',
    },
    {
      name: 'parameter before static',
      routes: [route('GET', '/users/:id'), route('GET', '/users/me')],
      message: 'GET /users/me is unreachable',
    },
    {
      name: 'wildcard before a nested static route',
      routes: [route('GET', '/files/*filePath'), route('GET', '/files/public/logo.svg')],
      message: 'GET /files/public/logo.svg is unreachable',
    },
    {
      name: 'ALL before one concrete method',
      routes: [route('ALL', '/health'), route('HEAD', '/health')],
      message: 'HEAD /health is unreachable',
    },
  ])('rejects $name', ({ routes, message }) => {
    expect(() => createHandler({ rawRoutes: [...routes] })).toThrow(message);
  });

  test('reports every conflict in one startup error', () => {
    expect(() =>
      createHandler({
        rawRoutes: [
          route('GET', '/users/:id'),
          route('GET', '/users/:userId'),
          route('GET', '/users/me'),
        ],
      }),
    ).toThrow(/same parameter shape[\s\S]*GET \/users\/me is unreachable/);
  });

  test.each([
    {
      name: 'independent methods',
      routes: [route('GET', '/users/:id'), route('HEAD', '/users/:id')],
    },
    {
      name: 'specific route before wildcard',
      routes: [route('GET', '/files/public/logo.svg'), route('GET', '/files/*filePath')],
    },
    {
      name: 'partial static overlap',
      routes: [route('GET', '/users/me'), route('GET', '/users/:id')],
    },
    {
      name: 'method-specific route before ALL',
      routes: [route('GET', '/health'), route('ALL', '/health')],
    },
  ])('allows $name', ({ routes }) => {
    expect(() => createHandler({ rawRoutes: [...routes] })).not.toThrow();
  });

  test('preserves first-match routing for a legal specific-before-wildcard pair', async () => {
    const fetchHandler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/files/public/logo.svg',
          handler: () => new Response('specific'),
        },
        {
          method: 'GET',
          path: '/files/*filePath',
          handler: (_request, context) => new Response(`wildcard:${context.params.filePath}`),
        },
      ],
    });

    expect(
      await (await fetchHandler(new Request('http://test/files/public/logo.svg'))).text(),
    ).toBe('specific');
    expect(await (await fetchHandler(new Request('http://test/files/other.txt'))).text()).toBe(
      'wildcard:other.txt',
    );
  });
});
