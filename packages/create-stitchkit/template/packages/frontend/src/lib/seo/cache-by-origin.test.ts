import { describe, expect, test } from 'bun:test';
import { cacheByOrigin } from './cache-by-origin';

describe('cacheByOrigin', () => {
  test('builds once per address, not once per request', () => {
    let builds = 0;
    const render = cacheByOrigin(
      (origin: string) => origin,
      (origin: string) => {
        builds += 1;
        return `${origin}/sitemap.xml`;
      },
    );

    expect(render('https://alpha.example')).toBe('https://alpha.example/sitemap.xml');
    expect(render('https://alpha.example')).toBe('https://alpha.example/sitemap.xml');
    expect(render('https://alpha.example')).toBe('https://alpha.example/sitemap.xml');
    expect(builds).toBe(1);

    expect(render('https://beta.example')).toBe('https://beta.example/sitemap.xml');
    expect(builds).toBe(2);
  });

  test('a forged Host cannot grow the cache without limit', () => {
    let builds = 0;
    const render = cacheByOrigin(
      (origin: string) => origin,
      (origin: string) => {
        builds += 1;
        return origin;
      },
      2,
    );

    render('a');
    render('b');
    render('c'); // evicts the least recently used, 'a'
    expect(builds).toBe(3);

    render('c');
    render('b');
    expect(builds).toBe(3);

    render('a'); // evicted, so rebuilt — the cache stayed bounded
    expect(builds).toBe(4);
  });

  test('recency is refreshed on a hit, so a hot address is not evicted', () => {
    let builds = 0;
    const render = cacheByOrigin(
      (origin: string) => origin,
      (origin: string) => {
        builds += 1;
        return origin;
      },
      2,
    );

    render('hot');
    render('cold');
    render('hot'); // refreshes 'hot', leaving 'cold' as least recent
    render('new'); // evicts 'cold', not 'hot'
    expect(builds).toBe(3);

    render('hot');
    expect(builds).toBe(3);
  });
});
