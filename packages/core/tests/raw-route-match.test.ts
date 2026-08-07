import { describe, expect, test } from 'bun:test';
import { matchRawRoute } from '../src/server/router';
import type { RawRoute } from '../src/server/types';

const noop = (): Response => new Response(null);
const route = (path: string, method: RawRoute['method'] = 'GET'): RawRoute => ({
  method,
  path,
  handler: noop,
});

describe('matchRawRoute — :param + named trailing wildcard', () => {
  const fallback = [route('/app/:slug/*filePath')];

  test('param + wildcard matches a nested path under its declared name', () => {
    const m = matchRawRoute(fallback, 'GET', '/app/x/a/b/c');
    expect(m?.params).toEqual({ slug: 'x', filePath: 'a/b/c' });
  });

  test('param + wildcard matches the bare prefix (empty remainder)', () => {
    const m = matchRawRoute(fallback, 'GET', '/app/x');
    expect(m?.params).toEqual({ slug: 'x', filePath: '' });
  });

  test('wildcard segments are decoded before reaching the handler', () => {
    const m = matchRawRoute(fallback, 'GET', '/app/x/folder%20one/leaf%23two');
    expect(m?.params).toEqual({ slug: 'x', filePath: 'folder one/leaf#two' });
  });

  test('shorter-than-prefix path does not match', () => {
    expect(matchRawRoute(fallback, 'GET', '/app')).toBeNull();
  });
});

describe('matchRawRoute — ordering: specific before wildcard', () => {
  const routes = [
    route('/app/:slug/c/:filename'),
    route('/app/:slug'),
    route('/app/:slug/*filePath'),
  ];

  test('exact chunk route wins', () => {
    const m = matchRawRoute(routes, 'GET', '/app/x/c/main.js');
    expect(m?.route.path).toBe('/app/:slug/c/:filename');
    expect(m?.params).toEqual({ slug: 'x', filename: 'main.js' });
  });

  test('exact shell route wins for the bare path', () => {
    expect(matchRawRoute(routes, 'GET', '/app/x')?.route.path).toBe('/app/:slug');
  });

  test('wildcard catches an unmatched nested path', () => {
    const m = matchRawRoute(routes, 'GET', '/app/x/nested/deep');
    expect(m?.route.path).toBe('/app/:slug/*filePath');
    expect(m?.params).toEqual({ slug: 'x', filePath: 'nested/deep' });
  });
});

describe('matchRawRoute — wildcard-only named route', () => {
  const routes = [route('/static/*filePath')];

  test('matches the bare prefix and nested', () => {
    expect(matchRawRoute(routes, 'GET', '/static')?.params).toEqual({ filePath: '' });
    expect(matchRawRoute(routes, 'GET', '/static/a/b.css')?.params).toEqual({
      filePath: 'a/b.css',
    });
  });

  test('does not match a different prefix', () => {
    expect(matchRawRoute(routes, 'GET', '/other')).toBeNull();
  });

  test('method filter is respected', () => {
    expect(matchRawRoute(routes, 'POST', '/static/x')).toBeNull();
    expect(
      matchRawRoute([route('/static/*filePath', 'ALL')], 'POST', '/static/x'),
    ).not.toBeNull();
  });
});
