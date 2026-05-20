/**
 * Security regressions — locks in the audit fixes: prototype-pollution
 * defence, CORS credential safety, SSRF numeric-host rejection, path
 * containment.
 */
import { describe, expect, test } from 'bun:test';
import { isUnsafeKey, safeJsonParse } from '../src/internal/safe-json';
import { isWithinDir } from '../src/internal/within-dir';
import { parseCookies } from '../src/server/middleware/cookies';
import { assertCorsConfig, corsHeaders } from '../src/server/middleware/cors';
import { parseQueryParams } from '../src/server/request';

describe('safeJsonParse — prototype pollution', () => {
  test('drops __proto__ from a parsed object', () => {
    const parsed = safeJsonParse('{"__proto__":{"polluted":true},"ok":1}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed) === Object.prototype).toBe(true);
    expect((parsed as Record<string, unknown>).ok).toBe(1);
  });

  test('keeps legitimate data named constructor / prototype', () => {
    // Only `__proto__` pollutes via assignment; `constructor` / `prototype`
    // as own data keys are inert and must not be dropped.
    const parsed = safeJsonParse('{"constructor":1,"prototype":2,"safe":3}');
    expect(Object.hasOwn(parsed as object, 'constructor')).toBe(true);
    expect(Object.hasOwn(parsed as object, 'prototype')).toBe(true);
    expect((parsed as Record<string, unknown>).safe).toBe(3);
  });

  test('throws on invalid JSON, like JSON.parse', () => {
    expect(() => safeJsonParse('{not json')).toThrow();
  });

  test('isUnsafeKey flags __proto__ only', () => {
    expect(isUnsafeKey('__proto__')).toBe(true);
    expect(isUnsafeKey('constructor')).toBe(false);
    expect(isUnsafeKey('prototype')).toBe(false);
    expect(isUnsafeKey('userId')).toBe(false);
  });
});

describe('parseCookies — prototype pollution + malformed segments', () => {
  test('skips a __proto__ cookie', () => {
    const cookies = parseCookies('__proto__=x; sid=abc');
    expect(cookies.sid).toBe('abc');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('skips a segment with no `=`', () => {
    const cookies = parseCookies('flag; sid=abc');
    expect('flag' in cookies).toBe(false);
    expect(cookies.sid).toBe('abc');
  });
});

describe('parseQueryParams — prototype pollution', () => {
  test('skips a ?__proto__= key', () => {
    const query = parseQueryParams(new URL('http://x/?__proto__=evil&page=2'));
    expect(Object.hasOwn(query, '__proto__')).toBe(false);
    expect(query.page).toBe('2');
  });
});

describe('assertCorsConfig — credentialed wildcard', () => {
  test('throws on credentials + wildcard origin', () => {
    expect(() => assertCorsConfig({ origin: '*', credentials: true })).toThrow();
  });

  test('throws on credentials + omitted origin', () => {
    expect(() => assertCorsConfig({ credentials: true })).toThrow();
  });

  test('accepts credentials + an explicit origin list', () => {
    expect(() =>
      assertCorsConfig({ origin: ['https://app.example'], credentials: true }),
    ).not.toThrow();
  });
});

describe('corsHeaders — no credentials on a rejected origin', () => {
  test('a non-allowlisted origin gets neither Allow-Origin nor Allow-Credentials', () => {
    const headers = corsHeaders(
      { origin: ['https://app.example'], credentials: true },
      'https://evil.example',
    );
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  test('an allowlisted origin gets both', () => {
    const headers = corsHeaders(
      { origin: ['https://app.example'], credentials: true },
      'https://app.example',
    );
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  test('origin match is case-insensitive', () => {
    const headers = corsHeaders({ origin: ['https://App.Example'] }, 'https://app.example');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example');
  });
});

describe('isWithinDir — path containment', () => {
  test('a path inside the root passes', () => {
    expect(isWithinDir('/srv/static', '/srv/static/css/app.css')).toBe(true);
  });

  test('the root itself passes', () => {
    expect(isWithinDir('/srv/static', '/srv/static')).toBe(true);
  });

  test('an escaping path is rejected', () => {
    expect(isWithinDir('/srv/static', '/srv/secrets')).toBe(false);
    expect(isWithinDir('/srv/static', '/etc/passwd')).toBe(false);
  });

  test('a sibling with a shared prefix is rejected', () => {
    expect(isWithinDir('/srv/static', '/srv/static-evil/x')).toBe(false);
  });
});
