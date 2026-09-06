import { describe, expect, test } from 'bun:test';
import { extractToken, verifyJwt } from '../src/server/middleware/auth';
import {
  defineCookie,
  parseCookieHeader,
  parseCookies,
  serializeCookie,
} from '../src/server/middleware/cookies';
import { corsHeaders, DEFAULT_CORS_ALLOW_HEADERS } from '../src/server/middleware/cors';

describe('cookies', () => {
  test('parseCookies — basic', () => {
    const cookies = parseCookies('session=abc123; theme=dark; lang=en');
    expect(cookies.session).toBe('abc123');
    expect(cookies.theme).toBe('dark');
    expect(cookies.lang).toBe('en');
  });

  test('parseCookies — null header', () => {
    expect(parseCookies(null)).toEqual({});
  });

  test('parseCookies — cookie with = in value', () => {
    const cookies = parseCookies('token=abc=def=ghi');
    expect(cookies.token).toBe('abc=def=ghi');
  });

  test('serializeCookie — basic', () => {
    const cookie = serializeCookie('session', 'abc123');
    expect(cookie).toBe('session=abc123');
  });

  test('serializeCookie — with all options', () => {
    const cookie = serializeCookie('token', 'xyz', {
      maxAge: 3600,
      path: '/',
      domain: 'example.com',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Domain=example.com');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });
});

describe('cors', () => {
  test('corsHeaders — wildcard origin', () => {
    const headers = corsHeaders({ origin: '*' }, 'http://example.com');
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
  });

  test('corsHeaders — specific origin match', () => {
    const headers = corsHeaders({ origin: ['http://a.com', 'http://b.com'] }, 'http://b.com');
    expect(headers['Access-Control-Allow-Origin']).toBe('http://b.com');
  });

  test('corsHeaders — origin not in list', () => {
    const headers = corsHeaders({ origin: ['http://a.com'] }, 'http://evil.com');
    // A non-matching origin omits the header entirely (never an empty value).
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  test('corsHeaders — credentials', () => {
    const headers = corsHeaders({ origin: '*', credentials: true }, null);
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  test('default allow-headers permits the W3C trace headers the client emits', () => {
    // `createHttpClient({ trace: true })` sends `traceparent` on every request;
    // the default preflight must allow it, or the request dies cross-origin.
    const headers = corsHeaders({ origin: '*' }, 'http://example.com');
    const allow = headers['Access-Control-Allow-Headers'];
    expect(allow).toBe(DEFAULT_CORS_ALLOW_HEADERS);
    expect(allow).toContain('traceparent');
    expect(allow).toContain('tracestate');
    // The legacy simple trace id (`resolveTraceId` reads `x-trace-id`) stays.
    expect(allow).toContain('X-Trace-Id');
  });

  test('an explicit headers override still wins', () => {
    const headers = corsHeaders({ origin: '*', headers: 'Content-Type' }, null);
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type');
  });
});

describe('auth', () => {
  test('extractToken — from Authorization header', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer my-token-123' },
    });
    expect(extractToken(req)).toBe('my-token-123');
  });

  test('extractToken — from cookie', () => {
    const req = new Request('http://localhost', {
      headers: { Cookie: 'access_token=cookie-token; other=value' },
    });
    expect(extractToken(req, 'access_token')).toBe('cookie-token');
  });

  test('extractToken — no token', () => {
    const req = new Request('http://localhost');
    expect(extractToken(req)).toBeNull();
  });

  test('verifyJwt — invalid format', async () => {
    await expect(verifyJwt('not-a-jwt', 'secret')).rejects.toThrow();
  });

  // JWT segments are base64url (no `+` / `/` / `=`) — sign a spec-shaped token.
  const b64url = (s: string): string =>
    btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
    const signature = b64url(String.fromCharCode(...new Uint8Array(sig)));
    return `${header}.${body}.${signature}`;
  }

  test('verifyJwt — valid token round-trip', async () => {
    const secret = 'test-secret-key-12345';
    const token = await signJwt(
      { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 },
      secret,
    );
    const result = await verifyJwt(token, secret);
    expect(result.sub).toBe('user-1');
  });

  test('verifyJwt — expired token (beyond the clock-skew leeway)', async () => {
    const secret = 'test-secret';
    const token = await signJwt(
      { sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 3600 },
      secret,
    );
    await expect(verifyJwt(token, secret)).rejects.toThrow('expired');
  });

  test('verifyJwt — an empty secret is rejected loudly', async () => {
    const token = await signJwt({ sub: 'user-1' }, 'real-secret');
    await expect(verifyJwt(token, '')).rejects.toThrow('secret');
  });

  test('verifyJwt — a non-numeric exp is malformed, not non-expiring', async () => {
    const secret = 'test-secret';
    const token = await signJwt({ sub: 'user-1', exp: 'soon' }, secret);
    await expect(verifyJwt(token, secret)).rejects.toThrow();
  });
});

describe('two cookies with one name', () => {
  const twoDifferent = new Request('http://x', {
    headers: { cookie: 'sid=stale; theme=dark; sid=valid' },
  });
  const twoIdentical = new Request('http://x', { headers: { cookie: 'sid=same; sid=same' } });
  const one = new Request('http://x', { headers: { cookie: 'sid=only' } });
  const none = new Request('http://x');

  test('parseCookieHeader keeps every pair in header order', () => {
    expect(parseCookieHeader('sid=stale; theme=dark; sid=valid')).toEqual([
      ['sid', 'stale'],
      ['theme', 'dark'],
      ['sid', 'valid'],
    ]);
    expect(parseCookieHeader(null)).toEqual([]);
  });

  test('parseCookies is the same list collapsed, last wins, prototype keys dropped', () => {
    expect(parseCookies('sid=stale; sid=valid; __proto__=x')).toEqual({ sid: 'valid' });
  });

  test('getAll returns every candidate, decoded like get', () => {
    const encoded = new Request('http://x', { headers: { cookie: 'sid=a%20b; sid=c%' } });
    expect(defineCookie({ name: 'sid' }).getAll(twoDifferent)).toEqual(['stale', 'valid']);
    expect(defineCookie({ name: 'sid' }).getAll(encoded)).toEqual(['a b', 'c%']);
    expect(defineCookie({ name: 'sid' }).get(encoded)).toBe('c%');
    expect(defineCookie({ name: 'sid' }).getAll(none)).toEqual([]);
  });

  test('get answers with the last occurrence by default, as it always has', () => {
    expect(defineCookie({ name: 'sid' }).get(twoDifferent)).toBe('valid');
    expect(defineCookie({ name: 'sid', duplicates: 'last' }).get(twoDifferent)).toBe('valid');
  });

  test("duplicates: 'first' names the other coin", () => {
    expect(defineCookie({ name: 'sid', duplicates: 'first' }).get(twoDifferent)).toBe('stale');
  });

  test('reject yields undefined when two cookies with the same name carry different values', () => {
    expect(
      defineCookie({ name: 'sid', duplicates: 'reject' }).get(twoDifferent),
    ).toBeUndefined();
  });

  test('reject keeps a value two identical cookies agree on', () => {
    // A host cookie and a parent-domain cookie set by the same application are
    // one value twice, not a conflict — refusing them would lock the user out.
    expect(defineCookie({ name: 'sid', duplicates: 'reject' }).get(twoIdentical)).toBe('same');
  });

  test('a single cookie reads the same under every policy', () => {
    for (const duplicates of ['last', 'first', 'reject'] as const) {
      expect(defineCookie({ name: 'sid', duplicates }).get(one)).toBe('only');
      expect(defineCookie({ name: 'sid', duplicates }).get(none)).toBeUndefined();
    }
  });
});
