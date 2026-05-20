import { describe, expect, test } from 'bun:test';
import { cacheHeaders, createCache } from '../src/server/cache';
import { createRateLimiter } from '../src/server/rate-limit';

describe('cache', () => {
  test('set and get', () => {
    const cache = createCache();
    cache.set('key1', { data: 'hello' }, 60);

    expect(cache.get('key1')).toEqual({ data: 'hello' });
  });

  test('returns null for missing key', () => {
    const cache = createCache();
    expect(cache.get('nonexistent')).toBeNull();
  });

  test('expires after maxAge', async () => {
    const cache = createCache();
    cache.set('short', 'value', 0.1);

    expect(cache.get('short')).toBe('value');
    await Bun.sleep(150);
    expect(cache.get('short')).toBeNull();
  });

  test('invalidate by prefix', () => {
    const cache = createCache();
    cache.set('users:1', 'alice', 60);
    cache.set('users:2', 'bob', 60);
    cache.set('posts:1', 'post', 60);

    cache.invalidate('users');

    expect(cache.get('users:1')).toBeNull();
    expect(cache.get('users:2')).toBeNull();
    expect(cache.get('posts:1')).toBe('post');
  });

  test('clear removes all', () => {
    const cache = createCache();
    cache.set('a', 1, 60);
    cache.set('b', 2, 60);
    cache.clear();

    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });

  test('cacheHeaders formats correctly', () => {
    expect(cacheHeaders(300)).toEqual({ 'Cache-Control': 'public, max-age=300' });
    expect(cacheHeaders(60, 'private')).toEqual({ 'Cache-Control': 'private, max-age=60' });
  });
});

describe('rate limiter', () => {
  const config = { window: 1, max: 3 };

  test('allows requests within limit', () => {
    const limiter = createRateLimiter();
    expect(limiter.check('user:1', config)).toBe(true);
    expect(limiter.check('user:1', config)).toBe(true);
    expect(limiter.check('user:1', config)).toBe(true);
  });

  test('blocks after limit exceeded', () => {
    const limiter = createRateLimiter();
    limiter.check('user:2', config);
    limiter.check('user:2', config);
    limiter.check('user:2', config);

    expect(limiter.check('user:2', config)).toBe(false);
  });

  test('different keys are independent', () => {
    const limiter = createRateLimiter();
    limiter.check('a', config);
    limiter.check('a', config);
    limiter.check('a', config);

    expect(limiter.check('a', config)).toBe(false);
    expect(limiter.check('b', config)).toBe(true);
  });

  test('tokens refill over time', async () => {
    const limiter = createRateLimiter();
    const fastConfig = { window: 0.2, max: 2 };

    limiter.check('refill', fastConfig);
    limiter.check('refill', fastConfig);
    expect(limiter.check('refill', fastConfig)).toBe(false);

    await Bun.sleep(250);
    expect(limiter.check('refill', fastConfig)).toBe(true);
  });

  test('remaining count', () => {
    const limiter = createRateLimiter();
    expect(limiter.remaining('new', config)).toBe(3);

    limiter.check('new', config);
    expect(limiter.remaining('new', config)).toBe(2);
  });
});
