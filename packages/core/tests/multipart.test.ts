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
