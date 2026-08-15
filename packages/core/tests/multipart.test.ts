import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import {
  defineContract,
  type MultipartDescriptor,
  type MultipartFilePolicy,
} from '../src/contract';
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
          const result = await parseMultipart(req, { files: { file: {} } }, MetaSchema);
          const file = result.files.file;
          if (!(file instanceof File)) throw new Error('Expected file');
          return Response.json({
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            fields: result.fields,
          });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : 'Unknown error' },
            { status: 400 },
          );
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
    expect(data.error).toContain('Missing multipart file field');
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
          const result = await parseMultipart(req, { files: { file: {} } }, TypedSchema);
          return Response.json({ fields: result.fields });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : 'Unknown error' },
            { status: 400 },
          );
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
        const result = await parseMultipart(req, { files: { file: {} } });
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
        multipart: { files: { file: {} } },
        input: z.object({ title: z.string() }),
        output: z.object({ fileName: z.string(), fileSize: z.number(), title: z.string() }),
      },
    },
  );

  const service = implement(uploads, {
    create: (ctx) => {
      return {
        fileName: ctx.files.file.name,
        fileSize: ctx.files.file.size,
        title: ctx.input.title,
      };
    },
  });

  let server: ReturnType<typeof createServer>;

  test('setup server', () => {
    server = createServer({ services: [service], port: 0 });
    PORT = server.port ?? 0;
  });

  test('client sends FormData and server injects typed ctx.files + ctx.input', async () => {
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
    return server?.shutdown({ gracePeriodMs: 0 });
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
        multipart: { files: { file: {} } },
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
      'Invalid multipart file field',
    );
  });
});

describe('multipart descriptor request limits', () => {
  const uploads = defineContract(
    { prefix: 'up' },
    {
      tiny: {
        method: 'POST',
        path: '/tiny',
        desc: 'Tiny upload',
        multipart: { maxRequestBytes: 2000, files: { file: {} } },
        input: z.object({}),
        output: z.object({ size: z.number() }),
      },
      normal: {
        method: 'POST',
        path: '/normal',
        desc: 'Normal upload',
        multipart: { maxRequestBytes: 4000, files: { file: {} } },
        input: z.object({}),
        output: z.object({ size: z.number() }),
      },
    },
  );
  const svc = implement(uploads, {
    tiny: (ctx) => ({ size: ctx.files.file.size }),
    normal: (ctx) => ({ size: ctx.files.file.size }),
  });
  const server = createServer({ port: 0, services: [svc] });
  const base = `http://localhost:${server.port}`;

  afterAll(() => server.shutdown({ gracePeriodMs: 0 }));

  const upload = (path: string, bytes: number) => {
    const form = new FormData();
    form.append('file', new File(['x'.repeat(bytes)], 'f.bin'));
    return fetch(`${base}/up${path}`, { method: 'POST', body: form });
  };

  test('a descriptor request cap rejects an oversized request', async () => {
    expect((await upload('/tiny', 3000)).status).toBe(400);
  });

  test('per-route cap accepts a small upload', async () => {
    expect((await upload('/tiny', 50)).status).toBe(200);
  });

  test('a larger descriptor cap allows the same request', async () => {
    expect((await upload('/normal', 3000)).status).toBe(200);
  });

  test('the larger descriptor cap still rejects an over-limit upload', async () => {
    expect((await upload('/normal', 9000)).status).toBe(400);
  });
});

describe('typed multipart descriptor cardinality and policy', () => {
  const descriptor = {
    files: {
      cover: { required: false, maxBytes: 4, contentTypes: ['image/*'] },
      attachments: {
        multiple: true,
        maxFiles: 2,
        maxBytes: 5,
        contentTypes: ['text/plain'],
      },
    },
  } satisfies MultipartDescriptor;

  test('returns optional single and ordered multiple fields from one descriptor', async () => {
    const form = new FormData();
    form.append('attachments', new File(['one'], 'one.txt', { type: 'text/plain' }));
    form.append('attachments', new File(['two'], 'two.txt', { type: 'text/plain' }));
    const result = await parseMultipart(
      new Request('http://localhost', { method: 'POST', body: form }),
      descriptor,
    );
    expect(result.files.cover).toBeUndefined();
    const attachments = result.files.attachments;
    expect(Array.isArray(attachments)).toBe(true);
    if (!Array.isArray(attachments)) throw new Error('Expected attachments array');
    expect(attachments.map((file) => (file instanceof File ? file.name : 'invalid'))).toEqual([
      'one.txt',
      'two.txt',
    ]);
  });

  test('rejects duplicate single, extra file and text in a file field', async () => {
    const duplicate = new FormData();
    duplicate.append('cover', new File(['a'], 'a.png', { type: 'image/png' }));
    duplicate.append('cover', new File(['b'], 'b.png', { type: 'image/png' }));
    duplicate.append('attachments', new File(['one'], 'one.txt', { type: 'text/plain' }));
    await expect(
      parseMultipart(
        new Request('http://localhost', { method: 'POST', body: duplicate }),
        descriptor,
      ),
    ).rejects.toThrow('Too many files for multipart field: cover');

    const extra = new FormData();
    extra.append('attachments', new File(['one'], 'one.txt', { type: 'text/plain' }));
    extra.append('other', new File(['x'], 'x.txt', { type: 'text/plain' }));
    await expect(
      parseMultipart(
        new Request('http://localhost', { method: 'POST', body: extra }),
        descriptor,
      ),
    ).rejects.toThrow('Unexpected multipart file field: other');

    const wrongKind = new FormData();
    wrongKind.append('attachments', 'not a file');
    await expect(
      parseMultipart(
        new Request('http://localhost', { method: 'POST', body: wrongKind }),
        descriptor,
      ),
    ).rejects.toThrow('must contain a file');
  });

  test('enforces maxFiles, per-file bytes and exact/wildcard MIME policy', async () => {
    const tooMany = new FormData();
    for (const name of ['one', 'two', 'three']) {
      tooMany.append('attachments', new File([name], `${name}.txt`, { type: 'text/plain' }));
    }
    await expect(
      parseMultipart(
        new Request('http://localhost', { method: 'POST', body: tooMany }),
        descriptor,
      ),
    ).rejects.toThrow('Too many files');

    const exactLimit = new FormData();
    exactLimit.append('cover', new File(['1234'], 'cover.png', { type: 'IMAGE/PNG' }));
    exactLimit.append('attachments', new File(['12345'], 'file.txt', { type: 'text/plain' }));
    await expect(
      parseMultipart(
        new Request('http://localhost', { method: 'POST', body: exactLimit }),
        descriptor,
      ),
    ).resolves.toBeDefined();

    const oversized = new FormData();
    oversized.append('attachments', new File(['123456'], 'file.txt', { type: 'text/plain' }));
    await expect(
      parseMultipart(
        new Request('http://localhost', { method: 'POST', body: oversized }),
        descriptor,
      ),
    ).rejects.toThrow('exceeds 5 bytes');

    const mismatch = new FormData();
    mismatch.append('attachments', new File(['123'], 'file.pdf', { type: 'application/pdf' }));
    await expect(
      parseMultipart(
        new Request('http://localhost', { method: 'POST', body: mismatch }),
        descriptor,
      ),
    ).rejects.toThrow('Unsupported content type');
  });

  test('both bare and Ky-backed typed clients append repeated file fields', async () => {
    const contract = defineContract(
      { prefix: 'multi' },
      {
        upload: {
          method: 'POST',
          path: '/',
          desc: 'Upload multiple files',
          multipart: { files: { files: { multiple: true } } },
          output: z.object({ names: z.array(z.string()) }),
        },
      },
    );
    const service = implement(contract, {
      upload: ({ files }) => ({ names: files.files.map((file) => file.name) }),
    });
    const server = createServer({ port: 0, services: [service] });
    try {
      const baseUrl = `http://localhost:${server.port}`;
      const clients = [
        createClient(contract, { baseUrl }),
        createClient(contract, createHttpClient({ baseUrl, retry: { limit: 0 } })),
      ];
      for (const client of clients) {
        const result = await client.upload({
          files: [new File(['1'], 'one.txt'), new File(['2'], 'two.txt')],
        });
        expect(result.names).toEqual(['one.txt', 'two.txt']);
      }
    } finally {
      await server.shutdown({ gracePeriodMs: 0 });
    }
  });
});

const multipartTypes = defineContract(
  { prefix: 'multipart-types' },
  {
    upload: {
      method: 'POST',
      path: '/',
      desc: 'Multipart type surface',
      multipart: {
        files: {
          cover: {},
          attachments: { multiple: true },
          preview: { required: false },
        },
      },
    },
  },
);
const multipartTypeClient = createClient(multipartTypes, { baseUrl: 'http://localhost' });
function compileTimeMultipartChecks(): void {
  void multipartTypeClient.upload({
    cover: new Blob(),
    attachments: [new Blob()],
  });
  // @ts-expect-error required cover cannot be omitted
  void multipartTypeClient.upload({ attachments: [new Blob()] });
  // @ts-expect-error single fields reject arrays
  void multipartTypeClient.upload({ cover: [new Blob()], attachments: [new Blob()] });
  // @ts-expect-error multiple fields reject scalar files
  void multipartTypeClient.upload({ cover: new Blob(), attachments: new Blob() });
}
void compileTimeMultipartChecks;

// @ts-expect-error maxFiles requires multiple: true
const invalidMultipartPolicy: MultipartFilePolicy = { maxFiles: 2 };
void invalidMultipartPolicy;

describe('multipart descriptor definition-time validation', () => {
  const endpoint = (
    multipart: MultipartDescriptor,
  ): {
    method: 'POST';
    path: string;
    desc: string;
    multipart: MultipartDescriptor;
  } => ({
    method: 'POST',
    path: '/',
    desc: 'Validate multipart definition',
    multipart,
  });

  test('rejects empty fields and invalid limits', () => {
    expect(() =>
      defineContract({ prefix: 'empty-multipart' }, { upload: endpoint({ files: {} }) }),
    ).toThrow('must declare at least one file field');
    expect(() =>
      defineContract(
        { prefix: 'invalid-multipart-limit' },
        { upload: endpoint({ maxRequestBytes: 0, files: { file: {} } }) },
      ),
    ).toThrow('maxRequestBytes must be a positive safe integer');
  });

  test('rejects invalid content-type policy before the server starts', () => {
    expect(() =>
      defineContract(
        { prefix: 'invalid-multipart-content-type' },
        { upload: endpoint({ files: { file: { contentTypes: ['image'] } } }) },
      ),
    ).toThrow('invalid content type policy');
  });
});
