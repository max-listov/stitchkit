import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { serveFile } from '../src/server/file';

// "abcdefghijklmnopqrstuvwxyz" — index == byte value, so slices are easy to assert.
const CONTENT = 'abcdefghijklmnopqrstuvwxyz';
const SIZE = CONTENT.length; // 26
const PATH = join(tmpdir(), `stitchkit-serve-file-${process.pid}.mp4`);
const MISSING = join(tmpdir(), `stitchkit-serve-file-missing-${process.pid}.mp4`);

const get = (headers?: Record<string, string>) =>
  serveFile(new Request('http://x/file', { headers }), { path: PATH });

beforeAll(async () => {
  await Bun.write(PATH, CONTENT);
});
afterAll(async () => {
  await rm(PATH, { force: true });
});

describe('serveFile — full body', () => {
  test('200 with Content-Length, Accept-Ranges, ETag, detected type', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe(String(SIZE));
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('ETag')).toStartWith('W/"');
    expect(res.headers.get('Last-Modified')).toBeTruthy();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe(CONTENT);
  });
});

describe('serveFile — Range', () => {
  test('206 with correct Content-Range / Content-Length / body', async () => {
    const res = await get({ Range: 'bytes=0-3' });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-3/${SIZE}`);
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await res.text()).toBe('abcd');
  });

  test('206 suffix range', async () => {
    const res = await get({ Range: 'bytes=-3' });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 23-25/${SIZE}`);
    expect(await res.text()).toBe('xyz');
  });

  test('206 open-ended range', async () => {
    const res = await get({ Range: 'bytes=24-' });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 24-25/${SIZE}`);
    expect(await res.text()).toBe('yz');
  });

  test('416 unsatisfiable with Content-Range: bytes */size', async () => {
    const res = await get({ Range: 'bytes=9999-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${SIZE}`);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await res.text()).toBe('');
  });

  test('unparseable Range ignored → 200 full', async () => {
    const res = await get({ Range: 'bytes=abc' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
  });
});

describe('serveFile — HEAD', () => {
  const head = (headers?: Record<string, string>) =>
    serveFile(new Request('http://x/file', { method: 'HEAD', headers }), { path: PATH });

  test('200 headers, empty body', async () => {
    const res = await head();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(SIZE));
    expect(await res.text()).toBe('');
  });

  test('206 range headers, empty body', async () => {
    const res = await head({ Range: 'bytes=0-3' });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-3/${SIZE}`);
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(await res.text()).toBe('');
  });
});

describe('serveFile — conditional', () => {
  test('If-None-Match matching ETag → 304, empty body', async () => {
    const etag = (await get()).headers.get('ETag') ?? '';
    const res = await get({ 'If-None-Match': etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    expect(await res.text()).toBe('');
  });

  test('If-None-Match: * → 304', async () => {
    const res = await get({ 'If-None-Match': '*' });
    expect(res.status).toBe(304);
  });

  test('If-None-Match non-matching → 200', async () => {
    const res = await get({ 'If-None-Match': 'W/"deadbeef-1"' });
    expect(res.status).toBe(200);
  });

  test('If-Modified-Since in the future → 304', async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const res = await get({ 'If-Modified-Since': future });
    expect(res.status).toBe(304);
  });

  test('If-Modified-Since in the past → 200', async () => {
    const res = await get({ 'If-Modified-Since': new Date(0).toUTCString() });
    expect(res.status).toBe(200);
  });

  test('If-Range matching ETag honours the Range → 206', async () => {
    const etag = (await get()).headers.get('ETag') ?? '';
    const res = await get({ Range: 'bytes=0-3', 'If-Range': etag });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('abcd');
  });

  test('If-Range stale validator → full 200 (range ignored)', async () => {
    const res = await get({ Range: 'bytes=0-3', 'If-Range': 'W/"deadbeef-1"' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
  });
});

describe('serveFile — options & errors', () => {
  test('404 for a missing file', async () => {
    const res = await serveFile(new Request('http://x/file'), { path: MISSING });
    expect(res.status).toBe(404);
  });

  test('405 for non GET/HEAD with Allow header', async () => {
    const res = await serveFile(new Request('http://x/file', { method: 'POST' }), {
      path: PATH,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
  });

  test('contentType override + filename → Content-Disposition + cacheControl', async () => {
    const res = await serveFile(new Request('http://x/file'), {
      path: PATH,
      contentType: 'application/octet-stream',
      filename: 'clip.mp4',
      disposition: 'attachment',
      cacheControl: 'public, max-age=3600',
    });
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain('filename="clip.mp4"');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  test('etag/lastModified can be disabled', async () => {
    const res = await serveFile(new Request('http://x/file'), {
      path: PATH,
      etag: false,
      lastModified: false,
    });
    expect(res.headers.get('ETag')).toBeNull();
    expect(res.headers.get('Last-Modified')).toBeNull();
  });
});

describe('serveFile — disabled validators are not matched', () => {
  test('etag:false ignores a specific If-None-Match (validator not advertised) → 200', async () => {
    const realEtag = (await get()).headers.get('ETag') ?? '';
    const res = await serveFile(
      new Request('http://x/file', { headers: { 'If-None-Match': realEtag } }),
      { path: PATH, etag: false },
    );
    expect(res.status).toBe(200);
  });

  test('etag:false still honours If-None-Match: * (resource exists) → 304', async () => {
    const res = await serveFile(
      new Request('http://x/file', { headers: { 'If-None-Match': '*' } }),
      { path: PATH, etag: false },
    );
    expect(res.status).toBe(304);
  });

  test('lastModified:false ignores If-Modified-Since → 200', async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const res = await serveFile(
      new Request('http://x/file', { headers: { 'If-Modified-Since': future } }),
      { path: PATH, lastModified: false },
    );
    expect(res.status).toBe(200);
  });

  test('both disabled → no 304 at all (conditionals opted out)', async () => {
    const res = await serveFile(
      new Request('http://x/file', { headers: { 'If-None-Match': '*' } }),
      { path: PATH, etag: false, lastModified: false },
    );
    expect(res.status).toBe(200);
  });
});

describe('serveFile — via a raw route (HEAD reaches it through method ALL)', () => {
  const server = createServer({
    port: 0,
    // `ALL` so a HEAD probe reaches serveFile — raw routes match the method
    // exactly and `HEAD` is not a contract `HttpMethod`.
    rawRoutes: [
      { method: 'ALL', path: '/media', handler: (req) => serveFile(req, { path: PATH }) },
    ],
  });
  const base = `http://localhost:${server.port}`;
  afterAll(() => server.shutdown({ gracePeriodMs: 0 }));

  test('GET → 200 with full body', async () => {
    const res = await fetch(`${base}/media`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
  });

  test('HEAD → 200, Accept-Ranges, empty body', async () => {
    const res = await fetch(`${base}/media`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await res.text()).toBe('');
  });
});
