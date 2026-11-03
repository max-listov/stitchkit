/**
 * `staticRoute` answers a contained file through `serveFile`: validators, `304`,
 * single byte ranges and an optional `Cache-Control`, over a real server, while
 * the containment refusals stay what they were. → ADR 0281.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/entrypoints/server';
import { staticRoute } from '../src/server/file';

// Larger than one read chunk, so the streamed body is assembled from several.
const VIDEO = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);

let base = '';
let root = '';
let server: ReturnType<typeof createServer>;
let origin = '';

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'sk-static-route-'));
  root = join(base, 'public');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'clip.webm'), VIDEO);
  await writeFile(join(root, 'empty.txt'), '');
  await writeFile(join(base, 'secret.txt'), 'private');
  await symlink(join(base, 'secret.txt'), join(root, 'escape.txt'));
  server = createServer({
    port: 0,
    rawRoutes: [
      staticRoute('/static', root),
      staticRoute('/cached', root, { cacheControl: 'public, max-age=3600' }),
    ],
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.shutdown({ gracePeriodMs: 0 });
  if (base) await rm(base, { recursive: true, force: true });
});

describe('staticRoute — answers through serveFile', () => {
  test('a GET carries ETag, Last-Modified and Accept-Ranges, and its ETag revalidates to 304', async () => {
    const res = await fetch(`${origin}/static/clip.webm`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/webm');
    expect(res.headers.get('Content-Length')).toBe(String(VIDEO.byteLength));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Last-Modified')).toBeTruthy();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBeNull();
    const etag = res.headers.get('ETag') ?? '';
    expect(etag).toStartWith('W/"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(VIDEO);

    const again = await fetch(`${origin}/static/clip.webm`, {
      headers: { 'If-None-Match': etag },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  test('Range: bytes=0-99 is a 206 of exactly those bytes', async () => {
    const res = await fetch(`${origin}/static/clip.webm`, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-99/${VIDEO.byteLength}`);
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(VIDEO.subarray(0, 100));
  });

  test('an open range from the middle streams to the last byte', async () => {
    const res = await fetch(`${origin}/static/clip.webm`, {
      headers: { Range: 'bytes=123457-' },
    });
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(VIDEO.subarray(123_457));
  });

  test('an unsatisfiable range is a 416', async () => {
    const res = await fetch(`${origin}/static/clip.webm`, {
      headers: { Range: `bytes=${VIDEO.byteLength}-` },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${VIDEO.byteLength}`);
  });

  test('cacheControl sets Cache-Control on the full body, a range and a 304', async () => {
    const full = await fetch(`${origin}/cached/clip.webm`);
    expect(full.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const etag = full.headers.get('ETag') ?? '';
    await full.arrayBuffer();
    const range = await fetch(`${origin}/cached/clip.webm`, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(range.headers.get('Cache-Control')).toBe('public, max-age=3600');
    await range.arrayBuffer();
    const fresh = await fetch(`${origin}/cached/clip.webm`, {
      headers: { 'If-None-Match': etag },
    });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  test('an empty file is a 200 with no bytes', async () => {
    const res = await fetch(`${origin}/static/empty.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('0');
    expect(await res.text()).toBe('');
  });
});

describe('staticRoute — containment refusals', () => {
  test('a path that leaves the root is 403', async () => {
    const res = await fetch(`${origin}/static/%2e%2e%2fsecret.txt`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('private');
  });

  test('an in-root symlink to outside the root is 404', async () => {
    const res = await fetch(`${origin}/static/escape.txt`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('private');
  });

  test('a directory and a missing file are 404', async () => {
    expect((await fetch(`${origin}/static/nested`)).status).toBe(404);
    expect((await fetch(`${origin}/static/missing.webm`)).status).toBe(404);
  });
});
