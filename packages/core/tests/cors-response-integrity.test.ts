/**
 * `applyCors` must decorate a response, never reconstruct it.
 *
 * Rebuilding with `new Response(res.body, …)` silently corrupted partial
 * responses: on Bun, reading `.body` off a response built from
 * `Bun.file().slice()` re-reads the whole file, so a `206` kept an honest
 * `Content-Range` while shipping the entire payload. Every assertion here goes
 * over the wire — the bug is invisible to a direct `serveFile()` call, which is
 * why the existing suite missed it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { serveFile } from '../src/server/file';

const CONTENT = 'abcdefghijklmnopqrstuvwxyz';
const PATH = join(tmpdir(), `stitchkit-cors-range-${process.pid}.bin`);
const ORIGIN = 'https://app.example.com';

beforeAll(async () => {
  await Bun.write(PATH, CONTENT);
});
afterAll(async () => {
  await rm(PATH, { force: true });
});

// `port: 0` — a fixed port is a coin flip when the ephemeral range covers it.
const server = createServer({
  port: 0,
  // A list origin, so `corsHeaders` also emits `Vary: Origin` — the header that
  // used to clobber whatever the handler had set.
  cors: { origin: [ORIGIN] },
  rawRoutes: [
    { method: 'ALL', path: '/media', handler: (req) => serveFile(req, { path: PATH }) },
    {
      method: 'GET',
      path: '/varies',
      handler: () =>
        new Response('ok', { headers: { Vary: 'Accept-Encoding', 'X-Own': 'kept' } }),
    },
    { method: 'GET', path: '/go', handler: () => Response.redirect(`${base}/media`, 302) },
  ],
});
afterAll(() => server.stop(true));

const base = `http://localhost:${server.port}`;

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { Origin: ORIGIN, ...headers }, redirect: 'manual' });

describe('a ranged response survives CORS', () => {
  test('206 delivers exactly the requested bytes, not the whole file', async () => {
    const res = await get('/media', { Range: 'bytes=10-14' });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 10-14/${CONTENT.length}`);
    expect(res.headers.get('Content-Length')).toBe('5');
    // The regression: the body used to be `klmnopqrstuvwxyz` — Content-Length
    // and Content-Range stayed honest while the payload was the rest of the file.
    expect(await res.text()).toBe('klmno');
  });

  test('a range in the middle is not silently extended to EOF', async () => {
    const res = await get('/media', { Range: 'bytes=3-5' });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('def');
  });

  test('CORS headers still reach the ranged response', async () => {
    const res = await get('/media', { Range: 'bytes=0-1' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  test('a full GET is unchanged', async () => {
    const res = await get('/media');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
  });

  test('HEAD keeps an empty body and its headers', async () => {
    const res = await fetch(`${base}/media`, { method: 'HEAD', headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.text()).toBe('');
  });
});

describe('Vary is a list, not a slot', () => {
  test("the handler's Vary survives and Origin is appended", async () => {
    const res = await get('/varies');
    const vary = res.headers.get('Vary') ?? '';
    const fields = vary.split(',').map((f) => f.trim().toLowerCase());
    expect(fields).toContain('accept-encoding');
    expect(fields).toContain('origin');
    // Unrelated handler headers are untouched.
    expect(res.headers.get('X-Own')).toBe('kept');
  });

  test('Origin is not appended twice', async () => {
    const res = await get('/media');
    const fields = (res.headers.get('Vary') ?? '')
      .split(',')
      .map((f) => f.trim().toLowerCase());
    expect(fields.filter((f) => f === 'origin')).toHaveLength(1);
  });
});

describe('expose headers', () => {
  test('a cross-origin caller may read the download headers', async () => {
    const res = await get('/media', { Range: 'bytes=0-1' });
    const exposed = (res.headers.get('Access-Control-Expose-Headers') ?? '')
      .split(',')
      .map((f) => f.trim().toLowerCase());
    // Without these a browser cannot recover a filename, revalidate or resume.
    expect(exposed).toContain('content-disposition');
    expect(exposed).toContain('content-range');
    expect(exposed).toContain('etag');
  });
});

describe('immutable headers keep the rebuild fallback', () => {
  test('a redirect still gets CORS headers', async () => {
    // WHATWG marks `Response.redirect()` headers immutable — Node throws on
    // `set`, Bun currently allows it. Either way the response must come back
    // decorated, which is what the try/catch in `applyCors` buys.
    const res = await get('/go');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${base}/media`);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});

describe('cors config never falls open to a wildcard', () => {
  test('an empty or origin-less cors config is a construction error, not `*`', () => {
    // Regression: `cors: {}` and `cors: { origin: undefined }` used to emit
    // `Access-Control-Allow-Origin: *` — a security setting must never pick
    // the most permissive behaviour because a value went missing.
    expect(() => createServer({ port: 0, cors: {} })).toThrow(/`origin` is required/);
    expect(() => createServer({ port: 0, cors: { origin: undefined } })).toThrow(
      /`origin` is required/,
    );
    expect(() => createServer({ port: 0, cors: { origin: [] } })).toThrow(/empty list/);
  });

  test('allowing every origin stays available — as an EXPLICIT opt-in', () => {
    const open = createServer({ port: 0, cors: { origin: '*' } });
    open.stop();
  });
});
