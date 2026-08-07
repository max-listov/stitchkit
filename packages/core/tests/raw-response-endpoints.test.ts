/**
 * `rawResponse: true` — an endpoint whose handler returns the `Response` itself.
 *
 * The point of declaring it in the contract rather than dropping it into
 * `rawRoutes` is that it keeps the three things a raw route loses: the auth
 * gate, the typed client and a single route registry. Each is asserted here.
 * → ADR 0038.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';
import {
  createAuthHook,
  createServer,
  implement,
  isWithinDir,
  notFound,
  serveFile,
} from '../src/server';
import { generateOpenApiDocument } from '../src/server/openapi';
import { listToolNames } from '../src/tools/list-names';
import { collectTools } from '../src/tools/mount';
import { implementRemote } from '../src/tools/remote';

/** Read one operation out of the generated document without a cast. */
function operation(doc: { paths: Record<string, Record<string, unknown>> }, path: string) {
  const item = doc.paths[path];
  if (!item) throw new Error(`no path ${path}`);
  const get = item.get;
  if (!get || typeof get !== 'object') throw new Error(`no GET on ${path}`);
  const responses = (get as { responses?: unknown }).responses;
  if (!responses || typeof responses !== 'object') throw new Error('no responses');
  return responses as Record<string, { description?: string; content?: object } | undefined>;
}

function noop(): void {
  /* silent log sink */
}

const CONTENT = 'abcdefghijklmnopqrstuvwxyz';
const PATH = join(tmpdir(), `stitchkit-raw-endpoint-${process.pid}.pdf`);
await Bun.write(PATH, CONTENT);
afterAll(async () => {
  await rm(PATH, { force: true });
});

// `admin`, deliberately: the default scope is `public`, and `createAuthHook`
// returns early on a public scope — a gate test written against the default
// would pass while proving nothing.
const contract = defineContract(
  { prefix: 'documents', scope: 'admin' },
  {
    download: {
      method: 'GET',
      path: '/:id/pdf',
      desc: 'Download a document as a PDF',
      params: z.object({ id: z.string() }),
      rawResponse: true,
      contentType: 'application/pdf',
    },
    // A normal endpoint beside it — every assertion about "raw is special" has
    // to hold against a sibling that is not.
    info: {
      method: 'GET',
      path: '/:id',
      desc: 'Document metadata',
      params: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
);

let handlerCalls = 0;
const afterHandleSaw: string[] = [];
const service = implement(contract, {
  download: (ctx) => {
    handlerCalls++;
    // No guard on the first line — that is the whole claim being tested.
    return serveFile(ctx.req, { path: PATH, filename: `${ctx.params.id}.pdf` });
  },
  info: (ctx) => ({ id: ctx.params.id }),
});

// `port: 0` — the OS assigns a free one. A fixed port is a coin flip: the
// ephemeral range on a dev box can cover the whole 1024-65535 space, so any
// outbound connection may already hold the number a test hard-codes.
const server = createServer({
  port: 0,
  services: [service],
  hooks: {
    beforeHandle: createAuthHook({
      resolve: async (ctx) => (ctx.req?.headers.get('authorization') ? { id: 'u1' } : null),
      rules: { admin: 'authenticated', public: 'public' },
    }),
    // Records what it was handed. A raw endpoint must not appear here at all —
    // before ADR 0038 this hook received the `Response`, wrapped it, and `json()`
    // serialized the lot to `{}` with status 200.
    afterHandle: (_ctx, result, endpoint) => {
      afterHandleSaw.push(
        `${endpoint.key}:${result instanceof Response ? 'Response' : 'data'}`,
      );
      return undefined;
    },
  },
});
afterAll(() => server.stop(true));

const base = `http://localhost:${server.port}`;
const AUTH = { authorization: 'Bearer t' };

describe('the auth gate applies without a guard in the handler', () => {
  test('anonymous → 401, and the handler never ran', async () => {
    const before = handlerCalls;
    const res = await fetch(`${base}/documents/abc/pdf`);
    expect(res.status).toBe(401);
    expect(handlerCalls).toBe(before);
  });

  test('authenticated → 200 with the bytes', async () => {
    const res = await fetch(`${base}/documents/abc/pdf`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
  });
});

describe('the response reaches the wire untouched', () => {
  test('afterHandle is skipped for raw and still runs for its sibling', async () => {
    afterHandleSaw.length = 0;

    const info = await fetch(`${base}/documents/abc`, { headers: AUTH });
    expect(await info.json()).toEqual({ id: 'abc' });
    // The sibling proves the hook is live — otherwise "raw skips it" would be
    // indistinguishable from "the hook was never wired".
    expect(afterHandleSaw).toEqual(['info:data']);

    const pdf = await fetch(`${base}/documents/abc/pdf`, { headers: AUTH });
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(await pdf.text()).toBe(CONTENT);
    expect(afterHandleSaw).toEqual(['info:data']);
  });

  test('serveFile keeps Range, ETag and 304 through the contract path', async () => {
    const ranged = await fetch(`${base}/documents/abc/pdf`, {
      headers: { ...AUTH, Range: 'bytes=2-4' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')).toBe(`bytes 2-4/${CONTENT.length}`);
    expect(await ranged.text()).toBe('cde');

    const full = await fetch(`${base}/documents/abc/pdf`, { headers: AUTH });
    const etag = full.headers.get('ETag');
    expect(etag).toBeTruthy();
    const conditional = await fetch(`${base}/documents/abc/pdf`, {
      headers: { ...AUTH, 'If-None-Match': etag ?? '' },
    });
    expect(conditional.status).toBe(304);
  });

  test('params still parse and reach the handler', async () => {
    const res = await fetch(`${base}/documents/xyz/pdf`, { headers: AUTH });
    expect(res.headers.get('Content-Disposition')).toContain('xyz.pdf');
  });

  test('the mirror case — a non-raw handler returning a Response fails loudly', async () => {
    // This is what the guide's own `return streamSSE(...)` example did: the
    // response was serialized to `{}` with status 200 and nothing said so.
    const sneaky = implement(
      defineContract(
        { prefix: 'sneaky' },
        { go: { method: 'GET', path: '/', desc: 'Returns a Response without declaring raw' } },
      ),
      { go: () => new Response('bytes') as unknown as undefined },
    );
    const s = createServer({ port: 0, services: [sneaky] });
    const port = s.port;
    try {
      const res = await fetch(`http://localhost:${port}/sneaky`);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).toContain('rawResponse: true');
    } finally {
      s.stop(true);
    }
  });

  test('…including a Response smuggled in by an afterHandle hook', async () => {
    // The check sits after the hooks precisely so this path is covered too —
    // otherwise the fix would be narrower than the changelog claims.
    const plain = implement(
      defineContract(
        { prefix: 'hooked' },
        { go: { method: 'GET', path: '/', desc: 'Normal endpoint' } },
      ),
      { go: () => undefined },
    );
    const s = createServer({
      port: 0,
      services: [plain],
      hooks: { afterHandle: () => new Response('sneaky') },
    });
    const port = s.port;
    try {
      const res = await fetch(`http://localhost:${port}/hooked`);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).toContain('afterHandle');
    } finally {
      s.stop(true);
    }
  });

  test('a handler that returns data instead of a Response fails loudly', async () => {
    const broken = implement(
      defineContract(
        { prefix: 'broken' },
        { go: { method: 'GET', path: '/', desc: 'Broken raw endpoint', rawResponse: true } },
      ),
      // The type forbids this; a runtime-assembled service can still do it.
      { go: () => ({ not: 'a response' }) as unknown as Response },
    );
    const s = createServer({ port: 0, services: [broken] });
    const port = s.port;
    try {
      const res = await fetch(`http://localhost:${port}/broken`);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).toContain('must return a Response');
    } finally {
      s.stop(true);
    }
  });
});

describe('never a tool, on any surface', () => {
  test('collectTools skips it on MCP, AGENT and CLI', () => {
    for (const transport of ['MCP', 'AGENT', 'CLI'] as const) {
      const names = collectTools(service, transport, {}).map((t) => t.name);
      expect(names).not.toContain('download_document');
      expect(names.some((n) => n.includes('download'))).toBe(false);
    }
  });

  test('listToolNames does not report it', () => {
    // The snapshot a consumer pins to catch accidental exposure — a raw endpoint
    // must never appear in it.
    const entries = listToolNames([service]);
    expect(entries.some((e) => e.method === 'download')).toBe(false);
    // …while the sibling is still there, so the assertion is not vacuous.
    expect(entries.some((e) => e.method === 'info')).toBe(true);
  });
});

describe('the contract refuses a nonsensical raw endpoint', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['an output schema', { output: z.object({ a: z.string() }) }, 'output schema'],
    ['a toolName', { toolName: 'grab' }, 'toolName'],
    ['MCP ui metadata', { ui: { resourceUri: 'ui://x' } }, 'ui metadata'],
    ['MCP annotations', { annotations: { title: 'X' } }, 'annotations'],
    ['a non-HTTP transport', { expose: ['HTTP', 'MCP'] }, 'HTTP-only'],
  ];
  for (const [what, extra, expected] of cases) {
    test(`throws at definition time on ${what}`, () => {
      expect(() =>
        defineContract({ prefix: 'p' }, {
          // Runtime-assembled: the type forbids each of these, this is the
          // second line of defence.
          go: { method: 'GET', path: '/', desc: 'd', rawResponse: true, ...extra },
        } as never),
      ).toThrow(expected);
    });
  }

  test('a bare raw endpoint is accepted', () => {
    expect(() =>
      defineContract(
        { prefix: 'p' },
        { go: { method: 'GET', path: '/', desc: 'Fine', rawResponse: true } },
      ),
    ).not.toThrow();
  });
});

describe('the typed client hands back the Response', () => {
  test('bare-fetch client — headers and bytes both survive', async () => {
    const client = createClient(contract, { baseUrl: base, headers: AUTH });
    const res = await client.download({ id: 'abc' });
    // Typed as `Response`, not `undefined` — the filename lives in the headers,
    // which is why this is a Response and not a Blob.
    expect(res.headers.get('Content-Disposition')).toContain('abc.pdf');
    expect(await res.text()).toBe(CONTENT);
  });

  test('HttpClient (ky) path — same result', async () => {
    const http = createHttpClient({ baseUrl: base, headers: () => AUTH });
    const client = createClient(contract, http);
    const res = await client.download({ id: 'abc' });
    expect(res.headers.get('Content-Disposition')).toContain('abc.pdf');
    expect(await res.text()).toBe(CONTENT);
  });

  test('a 401 still throws instead of resolving to an empty download', async () => {
    const client = createClient(contract, { baseUrl: base });
    await expect(client.download({ id: 'abc' })).rejects.toThrow();
  });
});

describe('implementRemote proxies the bytes through', () => {
  test('a gateway built on the proxy serves the file end to end', async () => {
    // The proxy forwards through `createClient`, which now asks for the raw
    // `Response` — so the bytes, status and headers survive the extra hop
    // instead of being parsed as JSON.
    const remote = implementRemote(
      contract,
      createHttpClient({ baseUrl: base, headers: () => AUTH }),
    );
    const gateway = createServer({ port: 0, services: [remote] });
    try {
      const res = await fetch(`http://localhost:${gateway.port}/documents/abc/pdf`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CONTENT);
      expect(res.headers.get('Content-Disposition')).toContain('abc.pdf');
    } finally {
      gateway.stop(true);
    }
  });

  test('exposure is forced to HTTP so old exposure readers stay right', () => {
    const remote = implementRemote(contract, createHttpClient({ baseUrl: base }));
    // Left undefined, the framework's own default convention reads
    // "MCP + AGENT on" — an audit script that predates `rawResponse` would call
    // a download a tool.
    expect(remote.methods.download?.expose).toEqual(['HTTP']);
    expect(
      implement(contract, { download: () => new Response(''), info: () => ({ id: 'x' }) })
        .methods.download?.expose,
    ).toEqual(['HTTP']);
    // The sibling is untouched.
    expect(remote.methods.info?.expose).toBeUndefined();
  });
});

describe('OpenAPI documents the media type, not "no content"', () => {
  test('200 with the declared contentType', () => {
    const doc = generateOpenApiDocument({
      services: [service],
      info: { title: 'T', version: '1' },
    });
    const responses = operation(doc, '/documents/{id}/pdf');
    expect(responses['204']).toBeUndefined();
    expect(responses['200']).toEqual({
      description: 'Success',
      content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
    });
  });

  test('without contentType it falls back to octet-stream', () => {
    const bare = implement(
      defineContract(
        { prefix: 'blobs' },
        { get: { method: 'GET', path: '/', desc: 'Bytes', rawResponse: true } },
      ),
      { get: () => new Response('x') },
    );
    const doc = generateOpenApiDocument({
      services: [bare],
      info: { title: 'T', version: '1' },
    });
    const responses = operation(doc, '/blobs');
    expect(Object.keys(responses['200']?.content ?? {})).toEqual(['application/octet-stream']);
  });
});

describe('a leftover raw route that shadows the endpoint is reported at startup', () => {
  // The migration this feature exists to enable is "move the download into the
  // contract to gain the auth gate". Forget to delete the old raw route and the
  // bytes keep being served ungated — raw routes match first. Silent, that is
  // the exact failure the feature is meant to prevent.
  function warningsFor(rawRoutes: Parameters<typeof createServer>[0]['rawRoutes']) {
    const lines: string[] = [];
    const s = createServer({
      port: 0,
      services: [service],
      rawRoutes,
      // Only `warn` is under test; the rest are deliberately silent sinks.
      logging: {
        logger: {
          debug: noop,
          info: noop,
          warn: (line: string) => lines.push(line),
          error: noop,
        },
      },
    });
    s.stop(true);
    return lines;
  }

  test('an exact-shape raw route is named, with the scope it bypasses', () => {
    const lines = warningsFor([
      { method: 'GET', path: '/documents/:id/pdf', handler: () => new Response('LEFTOVER') },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/documents/:id/pdf');
    expect(lines[0]).toContain('documents.download');
    expect(lines[0]).toContain('scope "admin"');
  });

  test('a wildcard raw route is caught too', () => {
    const lines = warningsFor([
      { method: 'ALL', path: '/documents/*filePath', handler: () => new Response('x') },
    ]);
    // Both the raw endpoint and its sibling are shadowed by the wildcard.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).toContain('documents.download');
  });

  test('a non-overlapping raw route is silent', () => {
    expect(
      warningsFor([{ method: 'GET', path: '/health', handler: () => new Response('ok') }]),
    ).toEqual([]);
  });

  test('no raw routes at all is silent', () => {
    expect(warningsFor(undefined)).toEqual([]);
  });
});

describe('multipart + rawResponse — upload in, bytes out', () => {
  // `multipart` describes the request, `rawResponse` the response, so the pair is
  // coherent ("convert this file and give it back"). Both client paths must agree;
  // the bare-fetch one used to parse the bytes as JSON while ky returned the
  // Response.
  const convert = defineContract(
    { prefix: 'convert' },
    {
      run: {
        method: 'POST',
        path: '/',
        desc: 'Convert an uploaded file',
        multipart: 'file',
        rawResponse: true,
        contentType: 'application/pdf',
      },
    },
  );
  const svc = implement(convert, { run: () => new Response('converted:ok') });
  const s = createServer({ port: 0, services: [svc] });
  afterAll(() => s.stop(true));
  const url = () => `http://localhost:${s.port}`;

  test('the bare-fetch client returns the Response, not a parse error', async () => {
    const client = createClient(convert, { baseUrl: url() });
    const res = await client.run({ file: new Blob(['x'], { type: 'text/plain' }) });
    expect(await res.text()).toBe('converted:ok');
  });

  test('the ky client agrees', async () => {
    const client = createClient(convert, createHttpClient({ baseUrl: url() }));
    const res = await client.run({ file: new Blob(['x'], { type: 'text/plain' }) });
    expect(await res.text()).toBe('converted:ok');
  });

  test('still never a tool', () => {
    expect(collectTools(svc, 'MCP', {})).toHaveLength(0);
  });
});

describe('the guide traversal recipe actually holds', () => {
  // `serveFile` trusts its `path` by design, so moving a file endpoint out of
  // `staticRoute` and into a contract trades a built-in containment check for a
  // hand-written one. The guide gives a recipe; this pins that it works.
  const files = defineContract(
    { prefix: 'files' },
    {
      get: {
        method: 'GET',
        path: '/:filename',
        desc: 'Serve an uploaded file',
        params: z.object({ filename: z.string() }),
        rawResponse: true,
      },
    },
  );
  const ROOT = resolve(tmpdir(), `stitchkit-files-${process.pid}`);
  const svc = implement(files, {
    get: (ctx) => {
      const target = resolve(ROOT, ctx.params.filename);
      if (!isWithinDir(ROOT, target)) throw notFound('File not found');
      return serveFile(ctx.req, { path: target });
    },
  });
  const s = createServer({ port: 0, services: [svc] });
  afterAll(async () => {
    s.stop(true);
    await rm(ROOT, { force: true, recursive: true });
  });

  test('a legitimate file is served', async () => {
    await Bun.write(join(ROOT, 'ok.txt'), 'INSIDE');
    const res = await fetch(`http://localhost:${s.port}/files/ok.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('INSIDE');
  });

  test('an escaping path is rejected before touching disk', async () => {
    // Encoded, or the URL would be normalised away before it ever reaches us.
    const res = await fetch(
      `http://localhost:${s.port}/files/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('root:');
  });
});
