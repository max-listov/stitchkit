/**
 * `sanitizePayload` / `redact` / `truncatePreview` / `measureSize` — the audit
 * layer's safety net. An audit row must never carry a secret or an unbounded
 * blob, so this asserts the masking and capping directly (the audit-hook tests
 * exercise the wiring, not the guarantees). A security-relevant module with no
 * direct coverage is a place a regression hides silently.
 */
import { describe, expect, test } from 'bun:test';
import { measureSize, redact, sanitizePayload, truncatePreview } from '../src/observability';

describe('redact — secret masking', () => {
  test('masks the default sensitive key names', () => {
    const out = redact({
      password: 'hunter2',
      apiKey: 'sk-123',
      api_key: 'sk-456',
      token: 'jwt.abc',
      authorization: 'Bearer x',
      sessionId: 'sess-1',
      cookie: 'a=b',
      initData: 'tg-init',
      privateKey: '-----BEGIN-----',
      username: 'max',
      count: 42,
    });
    expect(out).toEqual({
      password: '[redacted]',
      apiKey: '[redacted]',
      api_key: '[redacted]',
      token: '[redacted]',
      authorization: '[redacted]',
      sessionId: '[redacted]',
      cookie: '[redacted]',
      initData: '[redacted]',
      privateKey: '[redacted]',
      username: 'max',
      count: 42,
    });
  });

  test('masks secrets at any depth', () => {
    const out = redact({ user: { profile: { secret: 'x', name: 'ok' } } });
    expect(out).toEqual({ user: { profile: { secret: '[redacted]', name: 'ok' } } });
  });

  test('keeps audit identifiers whose names merely contain a sensitive word', () => {
    expect(redact({ authorId: 'u-1', sessionCount: 3, tokenizer: 'bpe' })).toEqual({
      authorId: 'u-1',
      sessionCount: 3,
      tokenizer: 'bpe',
    });
  });

  test('masks compound key names carrying a secret word (regression: anchored matching)', () => {
    const compound = {
      sessionToken: 's',
      clientSecret: 's',
      dbPassword: 's',
      apiToken: 's',
      authorizationHeader: 's',
      cookieHeader: 's',
      passwordHash: 's',
      'X-Api-Key': 's',
      accessToken: 's',
      refresh_token: 's',
      authHeader: 's',
      userCredentials: 's',
    };
    const out = redact(compound);
    for (const key of Object.keys(compound)) {
      expect(out).toHaveProperty(key, '[redacted]');
    }
  });

  test('word-boundary matching survives benign compounds around secret-looking words', () => {
    expect(
      redact({ author: 'max', authorized: true, tokenizer: 'bpe', keyboard: 'qwerty' }),
    ).toEqual({ author: 'max', authorized: true, tokenizer: 'bpe', keyboard: 'qwerty' });
  });

  test('serialises Map, Set and Error into useful JSON-safe shapes', () => {
    const error = new Error('failed');
    const out = redact({
      map: new Map([['key', 'value']]),
      set: new Set(['one']),
      error,
    });
    expect(out).toMatchObject({
      map: { _type: 'map', entries: [['key', 'value']] },
      set: { _type: 'set', values: ['one'] },
      error: { _type: 'error', name: 'Error', message: 'failed' },
    });
  });

  test('a custom sensitiveKeys pattern overrides the default', () => {
    const out = redact({ password: 'kept', ssn: '123' }, { sensitiveKeys: /ssn/i });
    expect(out).toEqual({ password: 'kept', ssn: '[redacted]' });
  });

  test('reduces binary blobs to size metadata, never the bytes', () => {
    const out = redact({ file: new Uint8Array([1, 2, 3, 4]) });
    expect(out).toEqual({ file: { _type: 'binary', size: 4 } });
  });

  test('drops a prototype-polluting key', () => {
    const out = redact(JSON.parse('{"__proto__": {"admin": true}, "ok": 1}'));
    expect(out).toEqual({ ok: 1 });
  });

  test('collapses a circular reference to a marker', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(redact(node)).toEqual({ name: 'root', self: '[circular]' });
  });

  test('walks a shared but acyclic subtree twice (not a false circular)', () => {
    const shared = { v: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  test('truncates past maxDepth', () => {
    // Root is depth 0, so a node at depth maxDepth+1 collapses: with maxDepth 2,
    // a(1) → b(2) → c(3) is truncated.
    const deep = { a: { b: { c: { d: 'x' } } } };
    expect(redact(deep, { maxDepth: 2 })).toEqual({ a: { b: { c: '[max depth]' } } });
  });
});

describe('truncatePreview', () => {
  test('passes a small value through unchanged', () => {
    expect(truncatePreview({ a: 1 })).toEqual({ a: 1 });
  });

  test('collapses an oversized value to a preview marker', () => {
    const big = { blob: 'x'.repeat(1000) };
    const out = truncatePreview(big, 100);
    expect(out).toMatchObject({ _truncated: true });
    if (typeof out === 'object' && out !== null && '_originalBytes' in out) {
      expect(out._originalBytes).toBeGreaterThan(100);
    }
  });

  test('uses a byte budget without splitting Unicode code points', () => {
    const out = truncatePreview({ value: '🌍'.repeat(100) }, 80);
    expect(JSON.stringify(out).length).toBeGreaterThan(0);
    if (
      typeof out === 'object' &&
      out !== null &&
      'preview' in out &&
      typeof out.preview === 'string'
    ) {
      expect(out.preview.isWellFormed()).toBe(true);
      expect(new TextEncoder().encode(out.preview).byteLength).toBeLessThanOrEqual(83);
    }
  });

  test('truncating a large payload does not starve the event loop (regression: quadratic re-encode)', async () => {
    // Count interval ticks over a fixed window that OVERLAPS the synchronous
    // truncation. If truncation blocks for the whole window, the deadline
    // timer fires the moment the loop is free again and almost no ticks have
    // accrued; a linear implementation leaves the window essentially idle.
    const big = { blob: 'э'.repeat(256 * 1024) };
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 5);
    const window = new Promise((resolve) => setTimeout(resolve, 60));
    const out = truncatePreview(big);
    await window;
    clearInterval(interval);
    expect(out).toMatchObject({ _truncated: true });
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe('sanitizePayload', () => {
  test('null / undefined reduce to null', () => {
    expect(sanitizePayload(null)).toBeNull();
    expect(sanitizePayload(undefined)).toBeNull();
  });

  test('redacts then caps in one pass', () => {
    expect(sanitizePayload({ token: 'secret', name: 'ok' })).toEqual({
      token: '[redacted]',
      name: 'ok',
    });
  });
});

describe('measureSize', () => {
  test('counts a bare array', () => {
    expect(measureSize([1, 2, 3]).resultSize).toBe(3);
  });

  test('counts a cursor page by its items', () => {
    expect(measureSize({ items: [1, 2], nextCursor: null }).resultSize).toBe(2);
  });

  test('does not miscount a plain object that merely has an items array', () => {
    expect(measureSize({ items: [1, 2, 3] }).resultSize).toBeNull();
  });

  test('null for a scalar, with a byte length', () => {
    const m = measureSize({ a: 1 });
    expect(m.resultSize).toBeNull();
    expect(m.responseBytes).toBeGreaterThan(0);
  });
});
