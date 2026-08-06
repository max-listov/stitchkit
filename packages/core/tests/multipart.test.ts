import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';
import { parseMultipart } from '../src/server/multipart';

describe('multipart parsing', () => {
  // Port 0 — the kernel picks a free one and `server.port` reports it. A fixed
  // number is a scheduled flake wherever the ephemeral range reaches down to it:
  // an unrelated *outgoing* connection can already hold the number, and the bind
  // then fails with a message about a server that does not exist.
  let PORT = 0;

  const MetaSchema = z.object({
    title: z.string(),
    category: z.string().optional(),
  });

  let server: ReturnType<typeof Bun.serve>;

  test('setup server', () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        try {
          const result = await parseMultipart(req, 'file', MetaSchema);
          return Response.json({
            fileName: result.file.name,
            fileSize: result.file.size,
            fileType: result.file.type,
            fields: result.fields,
          });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    });
    PORT = server.port ?? 0;
  });

  test('parses file + fields', async () => {
    const form = new FormData();
    form.append('file', new File(['hello world'], 'test.txt', { type: 'text/plain' }));
    form.append('title', 'My File');
    form.append('category', 'docs');

    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST', body: form });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.fileName).toBe('test.txt');
    expect(data.fileSize).toBe(11);
    expect(data.fields.title).toBe('My File');
    expect(data.fields.category).toBe('docs');
  });

  test('validates fields with Zod schema', async () => {
    const form = new FormData();
    form.append('file', new File(['x'], 'a.txt'));

    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  test('rejects missing file field', async () => {
    const form = new FormData();
    form.append('title', 'No file');

    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Missing file field');
  });

  test('a numeric-looking id stays a string under z.string() (no content sniffing)', async () => {
    // The regression this guards: `'33111715'` used to be JSON-parsed into a
    // number, failing the `z.string()` schema at random by id digits.
    const form = new FormData();
    form.append('file', new File(['data'], 'f.bin'));
    form.append('title', '33111715');

    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST', body: form });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.fields.title).toBe('33111715');
  });

  afterAll(() => {
    server?.stop();
  });
});

// ─── Field typing — the schema owns the type, never the content ──────────────

describe('multipart field typing', () => {
  let PORT = 0;

  // The convention: text fields arrive as strings; the schema coerces. A field
  // that should be JSON opts in explicitly via z.preprocess. Booleans use
  // `z.stringbool()`, NOT `z.coerce.boolean()` (which is `Boolean(str)` — every
  // non-empty string, including 'false', is truthy).
  const TypedSchema = z.object({
    count: z.coerce.number(),
    active: z.stringbool(),
    id: z.string(),
    tags: z.preprocess((v) => JSON.parse(String(v)), z.array(z.string())),
  });

  let server: ReturnType<typeof Bun.serve>;

  test('setup server', () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        try {
          const result = await parseMultipart(req, 'file', TypedSchema);
          return Response.json({ fields: result.fields });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    });
    PORT = server.port ?? 0;
  });

  test('coerces via the schema, and JSON is an explicit opt-in', async () => {
    const form = new FormData();
    form.append('file', new File(['x'], 'f.bin'));
    form.append('count', '5');
    form.append('active', 'true');
    form.append('id', 'ab12cd34');
    form.append('tags', JSON.stringify(['a', 'b']));

    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST', body: form });
    const data = await res.json();
    expect(res.status).toBe(200);
    // z.coerce turns the strings into their types; the schema decided, not the value.
    expect(data.fields).toEqual({ count: 5, active: true, id: 'ab12cd34', tags: ['a', 'b'] });
  });

  test("z.stringbool() decodes 'false' correctly (z.coerce.boolean would give true)", async () => {
    const form = new FormData();
    form.append('file', new File(['x'], 'f.bin'));
    form.append('count', '0');
    form.append('active', 'false');
    form.append('id', 'x');
    form.append('tags', '[]');

    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST', body: form });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.fields.active).toBe(false);
  });

  test('with no schema, fields come back as raw strings', async () => {
    // No schema — the fields are exactly the decoded strings, nothing coerced or
    // sniffed. Served over HTTP so the multipart boundary is real.
    const rawServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const result = await parseMultipart(req, 'file');
        return Response.json({ fields: result.fields });
      },
    });
    try {
      const form = new FormData();
      form.append('file', new File(['x'], 'f.bin'));
      form.append('count', '42');
      form.append('flag', 'true');
      const res = await fetch(`http://localhost:${rawServer.port}`, {
        method: 'POST',
        body: form,
      });
      expect((await res.json()).fields).toEqual({ count: '42', flag: 'true' });
    } finally {
      rawServer.stop();
    }
  });

  afterAll(() => server?.stop());
});

describe('multipart contract integration', () => {
  let PORT = 0;

  const uploads = defineContract(
    { prefix: 'uploads' },
    {
      create: {
        method: 'POST',
        path: '/',
        desc: 'Upload a file',
        multipart: 'file',
        input: z.object({ title: z.string() }),
        output: z.object({ fileName: z.string(), fileSize: z.number(), title: z.string() }),
      },
    },
  );

  const service = implement(uploads, {
    create: (ctx) => {
      // A `multipart` endpoint always has `ctx.file` — the router parses it.
      if (!ctx.file) throw new Error('Expected multipart file');
      return { fileName: ctx.file.name, fileSize: ctx.file.size, title: ctx.input.title };
    },
  });

  let server: ReturnType<typeof createServer>;

  test('setup server', () => {
    server = createServer({ services: [service], port: 0 });
    PORT = server.port ?? 0;
  });

  test('client sends FormData and server injects ctx.file + ctx.input', async () => {
    const api = createClient(uploads, { baseUrl: `http://localhost:${PORT}` });
    const result = await api.create({
      file: new File(['hello'], 'hello.txt', { type: 'text/plain' }),
      title: 'Hello',
    });

    expect(result.fileName).toBe('hello.txt');
    expect(result.fileSize).toBe(5);
    expect(result.title).toBe('Hello');
  });

  afterAll(() => {
    server?.stop();
  });
});

describe('multipart — platform file descriptor (React Native)', () => {
  const uploads = defineContract(
    { prefix: 'rn' },
    {
      create: {
        method: 'POST',
        path: '/',
        desc: 'Upload a file',
        multipart: 'file',
        input: z.object({ title: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
    },
  );

  // RN sends a file as a `{ uri, name, type }` descriptor (its `FormData` streams
  // it from disk). Bun's `FormData` has no notion of that, so this asserts the
  // *client* no longer rejects a non-`Blob` file and still sends the request —
  // not RN's on-device streaming, which only a device can exercise.
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  const base = `http://localhost:${server.port}`;
  afterAll(() => server.stop(true));

  test('typed client accepts a { uri, name, type } descriptor and sends the request', async () => {
    const api = createClient(uploads, { baseUrl: base });
    // Compiles → the multipart input type now accepts a descriptor, not only Blob.
    const result = await api.create({
      file: { uri: 'file:///audio.m4a', name: 'audio.m4a', type: 'audio/m4a' },
      title: 'Recording',
    });
    expect(result.ok).toBe(true);
  });

  test('Blob still works alongside the descriptor', async () => {
    const api = createClient(uploads, { baseUrl: base });
    const result = await api.create({
      file: new File(['hi'], 'hi.txt', { type: 'text/plain' }),
      title: 'Blob',
    });
    expect(result.ok).toBe(true);
  });

  test('rejects an object that is neither a Blob nor a full descriptor', async () => {
    const api = createClient(uploads, { baseUrl: base });
    // A partial object ({uri} only) must not pass the guard. Reached through a
    // structurally-widened reference (method-bivariance, cast-free) so the
    // runtime guard — not the compiler — is what rejects it, as it would for an
    // untyped JS caller.
    const loose: { create(args: Record<string, unknown>): Promise<unknown> } = api;
    await expect(loose.create({ file: { uri: 'file:///x' }, title: 't' })).rejects.toThrow(
      'Missing multipart file field',
    );
  });
});

describe('multipart maxUploadBytes — per-route + global', () => {
  // tiny: per-route cap 2000; normal: no per-route → falls back to global.
  const uploads = defineContract(
    { prefix: 'up' },
    {
      tiny: {
        method: 'POST',
        path: '/tiny',
        desc: 'Tiny upload',
        multipart: 'file',
        maxUploadBytes: 2000,
        input: z.object({}),
        output: z.object({ size: z.number() }),
      },
      normal: {
        method: 'POST',
        path: '/normal',
        desc: 'Normal upload',
        multipart: 'file',
        input: z.object({}),
        output: z.object({ size: z.number() }),
      },
    },
  );
  const svc = implement(uploads, {
    tiny: (ctx) => ({ size: ctx.file?.size ?? 0 }),
    normal: (ctx) => ({ size: ctx.file?.size ?? 0 }),
  });
  // global default 4000 — per-route `tiny` (2000) overrides it.
  const server = createServer({ port: 0, services: [svc], maxUploadBytes: 4000 });
  const base = `http://localhost:${server.port}`;

  afterAll(() => server.stop(true));

  const upload = (path: string, bytes: number) => {
    const form = new FormData();
    form.append('file', new File(['x'.repeat(bytes)], 'f.bin'));
    return fetch(`${base}/up${path}`, { method: 'POST', body: form });
  };

  test('per-route cap overrides the global — tiny rejects 3000 (global would allow)', async () => {
    expect((await upload('/tiny', 3000)).status).toBe(400);
  });

  test('per-route cap accepts a small upload', async () => {
    expect((await upload('/tiny', 50)).status).toBe(200);
  });

  test('global default applies when no per-route cap — normal allows 3000', async () => {
    expect((await upload('/normal', 3000)).status).toBe(200);
  });

  test('global default rejects an over-limit upload — normal rejects 9000', async () => {
    expect((await upload('/normal', 9000)).status).toBe(400);
  });
});
