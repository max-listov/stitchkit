/**
 * A streaming endpoint read through another runtime's fetch. React Native's `expo/fetch` answers
 * with its own `FetchResponse` class — `Symbol.toStringTag` `'Response'`, a web-stream `body`,
 * `clone()` by `tee()` — which is not the global `Response`. Both client paths read it by its
 * shape, and both refuse a response without a readable body by the same name.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { parseNDJSON } from '../src/browser/stream';
import type { ClientFetch } from '../src/browser/transport';
import { defineContract } from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';

const Event = z.object({ step: z.number().int() }).strict();

const contract = defineContract(
  { prefix: 'foreign-stream' },
  {
    watch: {
      method: 'POST',
      path: '/watch',
      desc: 'Watch a sign-in attempt',
      input: z.object({ attempt: z.string() }).strict(),
      stream: { item: Event, terminal: z.object({ step: z.literal(3) }).loose() },
    },
    events: {
      method: 'GET',
      path: '/events',
      desc: 'Server-sent events',
      stream: { item: Event, format: 'sse' },
    },
  },
);

const handler = createHandler({
  services: [
    implement(contract, {
      watch: async function* () {
        for (const step of [1, 2, 3]) yield { step };
      },
      events: async function* () {
        yield { step: 1 };
        yield { step: 2 };
      },
    }),
  ],
});

/** The shape of `expo/fetch`'s `FetchResponse` (expo 58): its own class over a native response. */
class ForeignFetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Headers;
  #body: ReadableStream<Uint8Array> | null;

  constructor(status: number, headers: Headers, body: ReadableStream<Uint8Array> | null) {
    this.status = status;
    this.statusText = '';
    this.url = '';
    this.headers = headers;
    this.#body = body;
  }

  get [Symbol.toStringTag](): string {
    return 'Response';
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  get body(): ReadableStream<Uint8Array> | null {
    return this.#body;
  }

  async text(): Promise<string> {
    return this.#body ? await new Response(this.#body).text() : '';
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  clone(): ForeignFetchResponse {
    if (!this.#body) return new ForeignFetchResponse(this.status, this.headers, null);
    const [own, sibling] = this.#body.tee();
    this.#body = own;
    return new ForeignFetchResponse(this.status, this.headers, sibling);
  }
}

/** A fetch whose responses are another runtime's class; `body` overrides what the response carries. */
function foreignFetch(body?: (real: Response) => unknown): ClientFetch {
  return async (input, init) => {
    const real = await handler(new Request(input, init));
    const answer = body
      ? {
          [Symbol.toStringTag]: 'Response',
          status: real.status,
          ok: real.ok,
          headers: real.headers,
          body: body(real),
          clone() {
            return this;
          },
          text: async () => '',
        }
      : new ForeignFetchResponse(real.status, real.headers, real.body);
    // The boundary under test: a fetch typed `Response` that answers with another class, as
    // `expo/fetch` does at runtime.
    return answer as unknown as Response;
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

const baseUrl = 'http://local';

describe('a streaming endpoint read through another runtime fetch', () => {
  test('the Ky client reads the foreign response as a stream of events', async () => {
    const client = createClient(
      contract,
      createHttpClient({ baseUrl, fetch: foreignFetch(), retry: { limit: 0 } }),
    );
    expect(await collect(await client.watch({ attempt: 'a' }))).toEqual([
      { step: 1 },
      { step: 2 },
      { step: 3 },
    ]);
    expect(await collect(await client.events())).toEqual([{ step: 1 }, { step: 2 }]);
  });

  test('the bare-fetch client reads the foreign response as a stream of events', async () => {
    const client = createClient(contract, { baseUrl, fetch: foreignFetch() });
    expect(await collect(await client.watch({ attempt: 'a' }))).toEqual([
      { step: 1 },
      { step: 2 },
      { step: 3 },
    ]);
    expect(await collect(await client.events())).toEqual([{ step: 1 }, { step: 2 }]);
  });

  test('a response without a readable body is refused by name on both client paths', async () => {
    for (const body of [
      () => null,
      () => undefined,
      // A body without `getReader`; `cancel` is what Ky calls on a body it drops.
      () => ({ cancel: async () => undefined }),
    ]) {
      const fetch = foreignFetch(body);
      for (const client of [
        createClient(contract, createHttpClient({ baseUrl, fetch, retry: { limit: 0 } })),
        createClient(contract, { baseUrl, fetch }),
      ]) {
        await expect(client.watch({ attempt: 'a' })).rejects.toThrow(
          'Streaming endpoint did not return a Response',
        );
      }
    }
  });

  test('the public readers take the foreign response as a Response', async () => {
    const response = await foreignFetch()(`${baseUrl}/foreign-stream/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attempt: 'a' }),
    });
    const frames = await collect(parseNDJSON<{ type: string }>(response));
    expect(frames.map((frame) => frame.type)).toEqual(['data', 'data', 'data', 'end']);
  });

  test('an async byte iterable that also carries a `body` field is read as the iterable', async () => {
    // A Node request after a body parser: async iterable, and `req.body` set to `undefined`.
    const request = Object.assign(
      (async function* () {
        yield new TextEncoder().encode('{"step":1}\n{"step":2}\n');
      })(),
      { body: undefined },
    );
    expect(await collect(parseNDJSON(request))).toEqual([{ step: 1 }, { step: 2 }]);
  });
});
