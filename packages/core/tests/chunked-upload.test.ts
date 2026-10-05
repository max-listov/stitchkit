/**
 * A chunked upload end to end: a contract of three endpoints, a stitchkit
 * server holding parts in `createChunkSpool`, and `uploadInChunks` on a typed
 * client. A dropped part is repeated and the upload goes on, a repeated `init`
 * of a finished upload sends no bytes, a cancel between parts never reaches
 * `finalize`, and the progress counts file bytes to the end.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import { type ChunkedUploadProgress, uploadInChunks } from '../src/browser/chunked-upload';
import { createClient } from '../src/browser/client';
import type { ClientFetch } from '../src/browser/transport';
import { defineContract } from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';
import { createChunkSpool } from '../src/files/chunk-spool';

const CHUNK_BYTES = 64 * 1024;
const Meta = z.object({ name: z.string() });
const Accepted = z.object({ sha256: z.string(), bytes: z.number() });

const contract = defineContract(
  { prefix: 'files' },
  {
    init: {
      method: 'POST',
      path: '/uploads',
      desc: 'Open an upload',
      input: z.object({
        uploadId: z.string(),
        totalBytes: z.number(),
        chunkCount: z.number(),
        name: z.string(),
      }),
      output: z.object({ finished: Accepted.optional() }),
    },
    chunk: {
      method: 'PUT',
      path: '/uploads/:uploadId/chunks/:index',
      desc: 'Send one part',
      params: z.object({ uploadId: z.string(), index: z.coerce.number() }),
      multipart: { files: { bytes: {} } },
      output: z.object({ state: z.enum(['stored', 'repeated']) }),
    },
    finalize: {
      method: 'POST',
      path: '/uploads/:uploadId/finalize',
      desc: 'Assemble the file',
      params: z.object({ uploadId: z.string() }),
      output: Accepted,
    },
  },
);

const directory = mkdtempSync(join(tmpdir(), 'sk-chunked-'));
const spool = createChunkSpool({
  directory,
  chunkBytes: CHUNK_BYTES,
  maxFileBytes: 10 * 1024 * 1024,
  meta: Meta,
});
const OWNER = 'user-1';
const finished = new Map<string, z.infer<typeof Accepted>>();
const calls: string[] = [];

const service = implement(contract, {
  init: async ({ input }) => {
    calls.push('init');
    const done = finished.get(input.uploadId);
    if (done) return { finished: done };
    await spool.open({
      owner: OWNER,
      uploadId: input.uploadId,
      totalBytes: input.totalBytes,
      chunkCount: input.chunkCount,
      meta: { name: input.name },
    });
    return {};
  },
  chunk: async ({ params, files }) => {
    calls.push(`chunk ${params.index}`);
    return {
      state: await spool.put({
        owner: OWNER,
        uploadId: params.uploadId,
        index: params.index,
        bytes: files.bytes,
      }),
    };
  },
  finalize: async ({ params }) => {
    calls.push('finalize');
    const key = { owner: OWNER, uploadId: params.uploadId };
    const assembled = await spool.assemble(key);
    const bytes = new Uint8Array(await new Response(assembled.stream()).arrayBuffer());
    const accepted = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    };
    await spool.discard(key);
    finished.set(params.uploadId, accepted);
    return accepted;
  },
});

const handler = createHandler({ services: [service] });
const server = Bun.serve({ port: 0, fetch: handler });
const baseUrl = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
});

// 3.5 parts: the last one is short.
const FILE = new File(
  [Uint8Array.from({ length: CHUNK_BYTES * 3 + CHUNK_BYTES / 2 }, (_, i) => i % 251)],
  'take.webm',
);
const FILE_SHA = createHash('sha256')
  .update(new Uint8Array(await FILE.arrayBuffer()))
  .digest('hex');

function upload(
  api: ReturnType<typeof createClient<typeof contract.endpoints>>,
  extra: {
    uploadId?: string;
    signal?: AbortSignal;
    onProgress?: (p: ChunkedUploadProgress) => void;
  } = {},
) {
  return uploadInChunks({
    file: FILE,
    chunkBytes: CHUNK_BYTES,
    retryDelayMs: 1,
    ...extra,
    init: async (start, options) => {
      const opened = await api.init.withOptions({ ...start, name: FILE.name }, options);
      return opened.finished ? { finished: opened.finished } : undefined;
    },
    chunk: ({ uploadId, index, bytes }, options) =>
      api.chunk.withOptions({ uploadId, index, bytes }, options),
    finalize: ({ uploadId }, options) => api.finalize.withOptions({ uploadId }, options),
  });
}

describe('uploadInChunks over a stitchkit server with createChunkSpool', () => {
  test('parts go in order and the server assembles the same file', async () => {
    const events: ChunkedUploadProgress[] = [];
    const result = await upload(createClient(contract, { baseUrl }), {
      onProgress: (progress) => events.push(progress),
    });
    expect(result).toEqual({ sha256: FILE_SHA, bytes: FILE.size });
    expect(calls).toEqual(['init', 'chunk 0', 'chunk 1', 'chunk 2', 'chunk 3', 'finalize']);
    expect(events[0]).toMatchObject({ sentBytes: 0, index: 0, chunkCount: 4 });
    expect(events.at(-1)).toMatchObject({ sentBytes: FILE.size, index: 4 });
    // Inside a part too, not only at part boundaries.
    expect(events.some((event) => event.sentBytes > 0 && event.sentBytes < CHUNK_BYTES)).toBe(
      true,
    );
    for (const [index, event] of events.entries()) {
      expect(event.sentBytes).toBeGreaterThanOrEqual(events[index - 1]?.sentBytes ?? 0);
    }
  });

  test('a part lost to the network is repeated and the upload goes on', async () => {
    let dropped = false;
    const flaky: ClientFetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!dropped && url.endsWith('/chunks/2')) {
        dropped = true;
        return Promise.reject(new TypeError('socket hang up'));
      }
      return fetch(input, init);
    };
    const result = await upload(createClient(contract, { baseUrl, fetch: flaky }));
    expect(dropped).toBe(true);
    expect(result.sha256).toBe(FILE_SHA);
    expect(calls).toEqual(['init', 'chunk 0', 'chunk 1', 'chunk 2', 'chunk 3', 'finalize']);
  });

  test('a part the server stored but whose answer was lost is repeated as "repeated"', async () => {
    let lost = false;
    const states: string[] = [];
    const losing: ClientFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const response = await fetch(input, init);
      if (!lost && url.endsWith('/chunks/1')) {
        lost = true;
        throw new TypeError('connection reset after the server answered');
      }
      if (url.includes('/chunks/')) states.push((await response.clone().json()).state);
      return response;
    };
    const result = await upload(createClient(contract, { baseUrl, fetch: losing }));
    expect(result.sha256).toBe(FILE_SHA);
    expect(states).toEqual(['stored', 'repeated', 'stored', 'stored']);
  });

  test('a repeated init of a finished upload returns its result without a byte', async () => {
    const api = createClient(contract, { baseUrl });
    const uploadId = crypto.randomUUID();
    const first = await upload(api, { uploadId });
    calls.length = 0;
    const events: ChunkedUploadProgress[] = [];
    const again = await upload(api, { uploadId, onProgress: (p) => events.push(p) });
    expect(again).toEqual(first);
    expect(calls).toEqual(['init']);
    expect(events).toEqual([
      { sentBytes: FILE.size, totalBytes: FILE.size, index: 4, chunkCount: 4, attempt: 1 },
    ]);
  });

  test('a cancel between parts never reaches finalize', async () => {
    const controller = new AbortController();
    const failure = await upload(createClient(contract, { baseUrl }), {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.index === 2) controller.abort();
      },
    }).catch((error: unknown) => error);
    expect(ApiError.is(failure) && failure.code).toBe('REQUEST_ABORTED');
    expect(calls).not.toContain('finalize');
    expect(calls).not.toContain('chunk 3');
  });

  test('a refusal is final: a conflicting part is not repeated', async () => {
    const api = createClient(contract, { baseUrl });
    const uploadId = crypto.randomUUID();
    await api.init({ uploadId, totalBytes: FILE.size, chunkCount: 4, name: FILE.name });
    await api.chunk({ uploadId, index: 0, bytes: FILE.slice(0, CHUNK_BYTES) });
    const other = new Blob([new Uint8Array(CHUNK_BYTES).fill(9)]);
    let chunkCalls = 0;
    const failure = await uploadInChunks({
      file: new File([other, FILE.slice(CHUNK_BYTES)], 'x'),
      chunkBytes: CHUNK_BYTES,
      uploadId,
      retryDelayMs: 1,
      init: async () => undefined,
      chunk: (part, options) => {
        chunkCalls += 1;
        return api.chunk.withOptions(part, options);
      },
      finalize: async () => 'never',
    }).catch((error: unknown) => error);
    expect(ApiError.is(failure) && [failure.code, failure.status]).toEqual([
      'UPLOAD_CONFLICT',
      409,
    ]);
    expect(chunkCalls).toBe(1);
  });

  test('a server that keeps failing exhausts the repeats and surfaces the last failure', async () => {
    let attempts = 0;
    const down: ClientFetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/chunks/')) {
        attempts += 1;
        return Promise.resolve(Response.json({ error: { code: 'BUSY' } }, { status: 503 }));
      }
      return fetch(input, init);
    };
    const failure = await upload(createClient(contract, { baseUrl, fetch: down })).catch(
      (error: unknown) => error,
    );
    expect(ApiError.is(failure) && failure.code).toBe('BUSY');
    expect(attempts).toBe(4);
    expect(calls).not.toContain('finalize');
  });

  test('retries and retryDelayMs bound the repeats of one part and pace them', async () => {
    const api = createClient(contract, { baseUrl });
    let attempts = 0;
    const started = performance.now();
    const failure = await uploadInChunks({
      file: FILE,
      chunkBytes: CHUNK_BYTES,
      retries: 1,
      retryDelayMs: 60,
      init: async (start, options) => {
        await api.init.withOptions({ ...start, name: FILE.name }, options);
        return undefined;
      },
      chunk: () => {
        attempts += 1;
        return Promise.reject(new TypeError('network down'));
      },
      finalize: async () => 'never',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(attempts).toBe(2);
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  test('finalize is never repeated, even on a failure that would repeat a part', async () => {
    const api = createClient(contract, { baseUrl });
    let finalizes = 0;
    const failure = await upload(api).then(async () =>
      uploadInChunks({
        file: FILE,
        chunkBytes: CHUNK_BYTES,
        retryDelayMs: 1,
        init: async (start, options) => {
          await api.init.withOptions({ ...start, name: FILE.name }, options);
          return undefined;
        },
        chunk: (part, options) => api.chunk.withOptions(part, options),
        finalize: () => {
          finalizes += 1;
          return Promise.reject(new TypeError('answer lost'));
        },
      }).catch((error: unknown) => error),
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(finalizes).toBe(1);
  });

  test('the signal is checked between parts, not only by the transport', async () => {
    const api = createClient(contract, { baseUrl });
    const controller = new AbortController();
    const sent: number[] = [];
    const failure = await uploadInChunks({
      file: FILE,
      chunkBytes: CHUNK_BYTES,
      signal: controller.signal,
      init: async (start) => {
        await api.init({ ...start, name: FILE.name });
        return undefined;
      },
      // The part call ignores the signal: only the driver can stop here.
      chunk: async (part) => {
        await api.chunk(part);
        sent.push(part.index);
        if (part.index === 1) controller.abort();
      },
      finalize: async () => 'finished',
    }).catch((error: unknown) => error);
    expect(ApiError.is(failure) && failure.code).toBe('REQUEST_ABORTED');
    expect(sent).toEqual([0, 1]);
  });

  test('a file that is not a Blob goes through its own size and slice', async () => {
    const api = createClient(contract, { baseUrl });
    const whole = new Uint8Array(await FILE.arrayBuffer());
    // A platform file handle: a size and a slice, none of the Blob surface.
    class DiskHandle {
      readonly size = whole.byteLength;
      readonly sliced: [number, number][] = [];
      slice(start: number, end: number): Uint8Array<ArrayBuffer> {
        this.sliced.push([start, end]);
        return whole.slice(start, end);
      }
    }
    const handle = new DiskHandle();
    // @ts-expect-error — the handle is not a Blob, and needs no cast to be a source.
    const notABlob: Blob = handle;
    expect(notABlob instanceof Blob).toBe(false);
    const events: ChunkedUploadProgress[] = [];
    const result = await uploadInChunks({
      file: handle,
      chunkBytes: CHUNK_BYTES,
      onProgress: (progress) => events.push(progress),
      init: async (start, options) => {
        await api.init.withOptions({ ...start, name: FILE.name }, options);
        return undefined;
      },
      chunk: ({ uploadId, index, bytes }, options) =>
        api.chunk.withOptions({ uploadId, index, bytes: new Blob([bytes]) }, options),
      finalize: ({ uploadId }, options) => api.finalize.withOptions({ uploadId }, options),
    });
    expect(result).toEqual({ sha256: FILE_SHA, bytes: FILE.size });
    expect(handle.sliced).toEqual([
      [0, CHUNK_BYTES],
      [CHUNK_BYTES, 2 * CHUNK_BYTES],
      [2 * CHUNK_BYTES, 3 * CHUNK_BYTES],
      [3 * CHUNK_BYTES, FILE.size],
    ]);
    expect(events.some((event) => event.sentBytes > 0 && event.sentBytes < CHUNK_BYTES)).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ sentBytes: FILE.size, index: 4 });
  });
});
