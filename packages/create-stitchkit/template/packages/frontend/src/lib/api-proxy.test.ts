import { afterAll, describe, expect, test } from 'bun:test';
import { forwardToApi } from './api-proxy';

const FILE_NAME = 'Счёт №7.xlsx';
const FILE = new TextEncoder().encode('файл с именем');
const DISPOSITION = `attachment; filename*=UTF-8''${encodeURIComponent(FILE_NAME)}`;
const seen = { cookie: '', origin: '', host: '' };

const api: Bun.Server<undefined> = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request): Response {
    const { pathname } = new URL(request.url);
    seen.cookie = request.headers.get('cookie') ?? '';
    seen.origin = request.headers.get('origin') ?? '';
    seen.host = request.headers.get('x-internal') ?? '';
    if (pathname === '/api/login') {
      const headers = new Headers();
      headers.append(
        'set-cookie',
        'session=a; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
      );
      headers.append('set-cookie', 'csrf=b; Path=/');
      return new Response(null, { status: 204, headers });
    }
    if (pathname === '/api/file') {
      return new Response(FILE, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': DISPOSITION,
          'content-length': String(FILE.byteLength),
        },
      });
    }
    if (pathname === '/api/gzip') {
      return new Response(Bun.gzipSync(new TextEncoder().encode('{"ok":true}')), {
        headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      });
    }
    if (pathname === '/api/absolute') {
      return new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${api.port}/next?step=2` },
      });
    }
    if (pathname === '/api/outside') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://provider.example/login' },
      });
    }
    if (pathname === '/api/echo') {
      return new Response(request.body, {
        headers: {
          'retry-after': '7',
          'www-authenticate': 'Bearer',
          'accept-ranges': 'bytes',
          'content-range': `bytes 0-1/${request.headers.get('range') ?? ''}`,
        },
      });
    }
    return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
  },
});
const apiUrl = `http://127.0.0.1:${api.port}`;
afterAll(() => api.stop(true));

function through(path: string, init?: RequestInit): Promise<Response> {
  return forwardToApi(new Request(`http://web.test${path}`, init), apiUrl);
}

describe('the web role forwarding to the API role', () => {
  test('a session reaches the API with its origin', async () => {
    await through('/api/me', {
      headers: {
        cookie: 'session=a',
        origin: 'http://web.test',
        'x-internal': 'not-forwarded',
      },
    });
    expect(seen).toEqual({ cookie: 'session=a', origin: 'http://web.test', host: '' });
  });

  test('every cookie comes back as a header of its own', async () => {
    const response = await through('/api/login', { method: 'POST' });
    expect(response.headers.getSetCookie()).toEqual([
      'session=a; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
      'csrf=b; Path=/',
    ]);
  });

  test('a download keeps a Cyrillic name, its length and its bytes', async () => {
    const response = await through('/api/file');
    expect(response.headers.get('content-disposition')).toBe(DISPOSITION);
    expect(response.headers.get('content-length')).toBe(String(FILE.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE);
  });

  test('a compressed answer does not carry the length of its compressed form', async () => {
    const response = await through('/api/gzip');
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  test('an upload streams through, and a refusal keeps what it tells the client', async () => {
    const body = new Uint8Array(3_000_000).fill(7);
    const response = await through('/api/echo', {
      method: 'POST',
      body,
      headers: { range: 'bytes=0-1' },
    });
    expect((await response.arrayBuffer()).byteLength).toBe(body.byteLength);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-1/bytes=0-1');
  });

  test('a redirect names no internal address', async () => {
    const internal = await through('/api/absolute');
    expect(internal.headers.get('location')).toBe('/next?step=2');
    const outside = await through('/api/outside');
    expect(outside.headers.get('location')).toBe('https://provider.example/login');
  });

  test('a redirect keeps its target', async () => {
    const response = await through('/api/moved');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/elsewhere');
  });
});
