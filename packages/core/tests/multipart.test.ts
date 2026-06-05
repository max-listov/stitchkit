import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';
import { parseMultipart } from '../src/server/multipart';

describe('multipart parsing', () => {
  const PORT = 9882;

  const MetaSchema = z.object({
    title: z.string(),
    category: z.string().optional(),
  });

  let server: ReturnType<typeof Bun.serve>;

  test('setup server', () => {
    server = Bun.serve({
      port: PORT,
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

  test('parses JSON string fields', async () => {
    const form = new FormData();
    form.append('file', new File(['data'], 'f.bin'));
    form.append('title', 'Test');
    form.append('category', 'media');

    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST', body: form });
    const data = await res.json();
    expect(data.fields.title).toBe('Test');
  });

  afterAll(() => {
    server?.stop();
  });
});

describe('multipart contract integration', () => {
  const PORT = 9883;

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
    server = createServer({ services: [service], port: PORT });
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

describe('multipart maxUploadBytes — per-route + global', () => {
  const PORT = 9903;
  const base = `http://localhost:${PORT}`;

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
  const server = createServer({ port: PORT, services: [svc], maxUploadBytes: 4000 });

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
