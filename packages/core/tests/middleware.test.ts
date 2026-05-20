import { describe, expect, test } from 'bun:test';
import { extractToken, verifyJwt } from '../src/server/middleware/auth';
import { parseCookies, serializeCookie } from '../src/server/middleware/cookies';
import { corsHeaders } from '../src/server/middleware/cors';

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

  test('verifyJwt — valid token round-trip', async () => {
    const secret = 'test-secret-key-12345';
    const payload = { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 };

    const encoder = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = btoa(JSON.stringify(payload));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
    const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
    const token = `${header}.${body}.${signature}`;

    const result = await verifyJwt(token, secret);
    expect(result.sub).toBe('user-1');
  });

  test('verifyJwt — expired token', async () => {
    const secret = 'test-secret';
    const payload = { sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 100 };

    const encoder = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = btoa(JSON.stringify(payload));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
    const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
    const token = `${header}.${body}.${signature}`;

    await expect(verifyJwt(token, secret)).rejects.toThrow('expired');
  });
});
