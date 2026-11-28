import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { searchParamsOf } from '../src/browser/http-fetch';
import { defineContract } from '../src/entrypoints/contract';
import * as httpEntry from '../src/entrypoints/http';
import * as rootEntry from '../src/entrypoints/index';

const SyncParamsSchema = z.object({ id: z.string() });
const SyncQuerySchema = z.object({
  limit: z.number().optional(),
  token: z.string().optional(),
  after: z.number().optional(),
  history: z.string().optional(),
  q: z.string().optional(),
  active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});
const EchoUrlSchema = z.object({ url: z.string() });

const syncContract = defineContract(
  { prefix: 'api/sync' },
  {
    snapshot: {
      method: 'GET',
      path: '/:id/snapshot',
      desc: 'Read snapshot page',
      params: SyncParamsSchema,
      input: SyncQuerySchema,
      output: EchoUrlSchema,
    },
    changes: {
      method: 'GET',
      path: '/:id/changes',
      desc: 'Read incremental changes',
      params: SyncParamsSchema,
      input: SyncQuerySchema,
      output: EchoUrlSchema,
    },
    purge: {
      method: 'DELETE',
      path: '/:id/snapshot',
      desc: 'Delete snapshot slice',
      params: SyncParamsSchema,
      input: SyncQuerySchema,
      output: EchoUrlSchema,
    },
  },
);

/**
 * Run a test body with `globalThis.URLSearchParams` replaced by a standalone
 * implementation that omits `URLSearchParams.prototype.size` (matching
 * `react-native-url-polyfill` / `whatwg-url-without-unicode`), restoring the
 * exact original global descriptor in `finally`.
 */
async function withUrlSearchParamsWithoutSize<T>(run: () => Promise<T> | T): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'URLSearchParams');
  const NativeURLSearchParams = globalThis.URLSearchParams;

  class SizelessURLSearchParams {
    readonly #inner: URLSearchParams;

    constructor(
      init?:
        | string
        | string[][]
        | Record<string, string>
        | URLSearchParams
        | SizelessURLSearchParams,
    ) {
      this.#inner =
        init instanceof SizelessURLSearchParams
          ? new NativeURLSearchParams(init.#inner)
          : new NativeURLSearchParams(init);
    }

    append(name: string, value: string): void {
      this.#inner.append(name, value);
    }

    delete(name: string, value?: string): void {
      this.#inner.delete(name, value);
    }

    get(name: string): string | null {
      return this.#inner.get(name);
    }

    getAll(name: string): string[] {
      return this.#inner.getAll(name);
    }

    has(name: string, value?: string): boolean {
      return this.#inner.has(name, value);
    }

    set(name: string, value: string): void {
      this.#inner.set(name, value);
    }

    sort(): void {
      this.#inner.sort();
    }

    entries(): URLSearchParamsIterator<[string, string]> {
      return this.#inner.entries();
    }

    keys(): URLSearchParamsIterator<string> {
      return this.#inner.keys();
    }

    values(): URLSearchParamsIterator<string> {
      return this.#inner.values();
    }

    forEach(
      callback: (value: string, key: string, parent: URLSearchParams) => void,
      thisArg?: unknown,
    ): void {
      this.#inner.forEach(callback, thisArg);
    }

    [Symbol.iterator](): URLSearchParamsIterator<[string, string]> {
      return this.#inner[Symbol.iterator]();
    }

    toString(): string {
      return this.#inner.toString();
    }
  }

  Object.defineProperty(globalThis, 'URLSearchParams', {
    value: SizelessURLSearchParams,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  try {
    const probe = new URLSearchParams('a=1');
    expect('size' in probe).toBe(false);
    expect(Reflect.get(probe, 'size')).toBeUndefined();
    expect(probe.toString()).toBe('a=1');
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'URLSearchParams', originalDescriptor);
    }
  }
}

function createUrlCaptureFetch(): { urls: string[]; fetch: httpEntry.ClientFetch } {
  const urls: string[] = [];
  const fetch: httpEntry.ClientFetch = async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { urls, fetch };
}

describe('HTTP client query serialization without URLSearchParams.prototype.size', () => {
  test('createClient and createUrlBuilder from stitchkit/http preserve query params without URLSearchParams.size', async () => {
    const NativeURLSearchParams = globalThis.URLSearchParams;

    await withUrlSearchParamsWithoutSize(async () => {
      const httpCapture = createUrlCaptureFetch();
      const fetchCapture = createUrlCaptureFetch();

      const httpAdapter = httpEntry.createHttpClient({
        baseUrl: 'https://example.test',
        fetch: httpCapture.fetch,
      });
      const httpClient = httpEntry.createClient(syncContract, httpAdapter);
      const bareClient = httpEntry.createClient(syncContract, {
        baseUrl: 'https://example.test',
        fetch: fetchCapture.fetch,
      });
      const urls = httpEntry.createUrlBuilder(syncContract, {
        baseUrl: 'https://example.test',
      });

      const scalarArgs = { id: 'x', limit: 100, token: 'tok_1' };
      const changesArgs = { id: 'x', after: 518, history: 'documents' };
      const arrayArgs = { id: 'x', tags: ['a', 'b'] };
      const emptyValueArgs = { id: 'x', q: '' };
      const mixedArgs = { id: 'x', q: '', limit: 0, active: false, tags: ['a', 'b'] };

      expect(urls.snapshot(scalarArgs)).toBe(
        'https://example.test/api/sync/x/snapshot?limit=100&token=tok_1',
      );
      expect(urls.changes(changesArgs)).toBe(
        'https://example.test/api/sync/x/changes?after=518&history=documents',
      );
      expect(urls.snapshot(arrayArgs)).toBe(
        'https://example.test/api/sync/x/snapshot?tags=a&tags=b',
      );
      expect(urls.snapshot(emptyValueArgs)).toBe(
        'https://example.test/api/sync/x/snapshot?q=',
      );

      // Negative controls: no trailing `?` when query parameters are absent, undefined, or empty arrays.
      expect(urls.snapshot({ id: 'x' })).toBe('https://example.test/api/sync/x/snapshot');
      expect(urls.snapshot({ id: 'x', q: undefined, token: undefined })).toBe(
        'https://example.test/api/sync/x/snapshot',
      );
      expect(urls.snapshot({ id: 'x', tags: [] })).toBe(
        'https://example.test/api/sync/x/snapshot',
      );

      for (const client of [httpClient, bareClient]) {
        await client.snapshot(scalarArgs);
        await client.changes(changesArgs);
        await client.snapshot(arrayArgs);
        await client.snapshot(emptyValueArgs);
        await client.snapshot(mixedArgs);
        await client.purge(emptyValueArgs);
        await client.snapshot({ id: 'x' });
        await client.snapshot({ id: 'x', q: undefined, token: undefined });
        await client.snapshot({ id: 'x', tags: [] });
      }

      const expected = [
        'https://example.test/api/sync/x/snapshot?limit=100&token=tok_1',
        'https://example.test/api/sync/x/changes?after=518&history=documents',
        'https://example.test/api/sync/x/snapshot?tags=a&tags=b',
        'https://example.test/api/sync/x/snapshot?q=',
        'https://example.test/api/sync/x/snapshot?q=&limit=0&active=false&tags=a&tags=b',
        'https://example.test/api/sync/x/snapshot?q=',
        'https://example.test/api/sync/x/snapshot',
        'https://example.test/api/sync/x/snapshot',
        'https://example.test/api/sync/x/snapshot',
      ];

      expect(httpCapture.urls).toEqual(expected);
      expect(fetchCapture.urls).toEqual(expected);
    });

    expect(globalThis.URLSearchParams).toBe(NativeURLSearchParams);
    expect(new URLSearchParams('a=1').size).toBe(1);
  });

  test('createHttpClient and createClient from stitchkit/http and stitchkit preserve options.params without URLSearchParams.size', async () => {
    const NativeURLSearchParams = globalThis.URLSearchParams;

    await withUrlSearchParamsWithoutSize(async () => {
      for (const makeHttpClient of [httpEntry.createHttpClient, rootEntry.createHttpClient]) {
        const capture = createUrlCaptureFetch();
        const http = makeHttpClient({
          baseUrl: 'https://example.test',
          fetch: capture.fetch,
        });

        await http.get('api/sync/x/snapshot', { params: { limit: 100, token: 'tok_1' } });
        await http.get('api/sync/x/changes', { params: { after: 518, history: 'documents' } });
        await http.get('api/sync/x/changes', { params: { tags: ['a', 'b'] } });
        await http.get('api/sync/x/changes', { params: { q: '' } });
        await http.get('api/sync/x/changes', {
          params: { after: 0, active: false, dropped: undefined, q: '' },
        });
        await http.get('api/sync/x/changes?existing=1', { params: { after: 518 } });

        // Negative controls: empty, all-undefined, or empty-array params do not add a trailing `?`.
        await http.get('api/sync/x/changes', { params: {} });
        await http.get('api/sync/x/changes', {
          params: { after: undefined, history: undefined },
        });
        await http.get('api/sync/x/changes', { params: { tags: [] } });

        expect(capture.urls).toEqual([
          'https://example.test/api/sync/x/snapshot?limit=100&token=tok_1',
          'https://example.test/api/sync/x/changes?after=518&history=documents',
          'https://example.test/api/sync/x/changes?tags=a&tags=b',
          'https://example.test/api/sync/x/changes?q=',
          'https://example.test/api/sync/x/changes?after=0&active=false&q=',
          'https://example.test/api/sync/x/changes?existing=1&after=518',
          'https://example.test/api/sync/x/changes',
          'https://example.test/api/sync/x/changes',
          'https://example.test/api/sync/x/changes',
        ]);
      }

      const rootClientCapture = createUrlCaptureFetch();
      const rootClient = rootEntry.createClient(
        syncContract,
        rootEntry.createHttpClient({
          baseUrl: 'https://example.test',
          fetch: rootClientCapture.fetch,
        }),
      );
      await rootClient.changes({ id: 'x', after: 518, history: 'documents' });
      await rootClient.snapshot({ id: 'x', tags: ['a', 'b'], q: '' });
      await rootClient.snapshot({ id: 'x' });
      expect(rootClientCapture.urls).toEqual([
        'https://example.test/api/sync/x/changes?after=518&history=documents',
        'https://example.test/api/sync/x/snapshot?tags=a&tags=b&q=',
        'https://example.test/api/sync/x/snapshot',
      ]);
    });

    expect(globalThis.URLSearchParams).toBe(NativeURLSearchParams);
    expect(new URLSearchParams('a=1').size).toBe(1);
  });

  test('searchParamsOf serializes query strings without reading URLSearchParams.size', async () => {
    await withUrlSearchParamsWithoutSize(() => {
      expect(searchParamsOf({ after: 518, history: 'documents' })).toBe(
        'after=518&history=documents',
      );
      expect(searchParamsOf({ tags: ['a', 'b'] })).toBe('tags=a&tags=b');
      expect(searchParamsOf({ q: '' })).toBe('q=');
      expect(searchParamsOf({ '?k': 'v' })).toBe('%3Fk=v');
      expect(searchParamsOf({ a: undefined, b: 'ok' })).toBe('b=ok');

      // Negative controls
      expect(searchParamsOf({})).toBeUndefined();
      expect(searchParamsOf({ a: undefined, b: undefined })).toBeUndefined();
      expect(searchParamsOf({ tags: [] })).toBeUndefined();
    });
  });
});
