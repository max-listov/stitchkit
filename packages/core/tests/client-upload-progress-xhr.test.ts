/**
 * `onUploadProgress` in a browser: with no injected fetch the body goes out
 * through `XMLHttpRequest`, whose upload events are the count. A stand-in XHR
 * relays the request to a real server, so the response the client parses is a
 * real one; what it proves is the wiring — headers, credentials, events,
 * errors, cancellation — not a browser's network stack.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import type { UploadProgress } from '../src/contract/client-types';
import { defineContract } from '../src/entrypoints/contract';

const contract = defineContract(
  { prefix: 'xhr' },
  {
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Receive a file',
      multipart: { files: { file: {} } },
      output: z.object({ bytes: z.number(), cookie: z.string().nullable() }),
    },
    busy: {
      method: 'POST',
      path: '/busy',
      desc: 'Refuse with an envelope',
      input: z.object({ text: z.string() }),
      output: z.object({ bytes: z.number() }),
    },
    forget: {
      method: 'POST',
      path: '/forget',
      desc: 'Answer 204',
      input: z.object({ text: z.string() }),
    },
  },
);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const bytes = (await request.arrayBuffer()).byteLength;
    if (path.endsWith('/busy')) {
      return Response.json(
        { error: { code: 'BUSY', message: 'try later' } },
        { status: 503, headers: { 'x-trace-id': 'trace-1' } },
      );
    }
    if (path.endsWith('/forget')) return new Response(null, { status: 204 });
    return Response.json({ bytes, cookie: request.headers.get('x-cookie-mode') });
  },
});
const baseUrl = `http://localhost:${server.port}`;

interface ProgressEventLike {
  loaded: number;
  total: number;
}

/** What the client sees of `XMLHttpRequest`, relayed to the real server above. */
class RelayXhr {
  static opened: RelayXhr[] = [];
  static hold = false;
  method = '';
  url = '';
  readonly headers = new Map<string, string>();
  withCredentials = false;
  responseType = '';
  status = 0;
  statusText = '';
  response: unknown = null;
  aborted = false;
  private responseHeaders = '';
  readonly upload: { onprogress?: (event: ProgressEventLike) => void; onload?: () => void } =
    {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    RelayXhr.opened.push(this);
  }

  setRequestHeader(name: string, value: string): void {
    if (name === 'content-length') throw new Error('a browser refuses content-length');
    this.headers.set(name, value);
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  send(body: Uint8Array<ArrayBuffer> | null): void {
    void this.relay(body);
  }

  private async relay(body: Uint8Array<ArrayBuffer> | null): Promise<void> {
    await Bun.sleep(1);
    if (RelayXhr.hold || this.aborted) return;
    const total = body?.byteLength ?? 0;
    for (const loaded of [Math.floor(total / 3), Math.floor((2 * total) / 3), total]) {
      this.upload.onprogress?.({ loaded, total });
    }
    this.upload.onload?.();
    const headers = new Headers([...this.headers]);
    headers.set('x-cookie-mode', this.withCredentials ? 'include' : 'same-origin');
    const response = await fetch(this.url, { method: this.method, headers, body });
    this.status = response.status;
    this.statusText = response.statusText;
    this.responseHeaders = [...response.headers]
      .map(([name, value]) => `${name}: ${value}`)
      .join('\r\n');
    this.response = await response.arrayBuffer();
    this.onload?.();
  }
}

beforeAll(() => {
  Reflect.set(globalThis, 'XMLHttpRequest', RelayXhr);
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
  server.stop(true);
});

const FILE = new File([new Uint8Array(120_000).fill(3)], 'take.webm', { type: 'audio/webm' });

function recorder(): { events: UploadProgress[]; listen: (progress: UploadProgress) => void } {
  const events: UploadProgress[] = [];
  return { events, listen: (progress) => events.push(progress) };
}

function bareClient() {
  return createClient(contract, { baseUrl });
}
function kyClient(): ReturnType<typeof bareClient> {
  return createClient(contract, createHttpClient({ baseUrl }));
}
const transports: readonly (readonly [string, () => ReturnType<typeof bareClient>])[] = [
  ['bare fetch', bareClient],
  ['Ky client', kyClient],
];

describe.each(transports)('the XMLHttpRequest route of the %s', (name, makeClient) => {
  test('counts upload events from 0 to the body the server received', async () => {
    RelayXhr.opened = [];
    const { events, listen } = recorder();
    const received = await makeClient().upload.withOptions(
      { file: FILE },
      { onUploadProgress: listen },
    );
    const [xhr] = RelayXhr.opened;
    expect(xhr?.headers.get('content-type')).toStartWith('multipart/form-data; boundary=');
    expect(xhr?.responseType).toBe('arraybuffer');
    expect(events.map((event) => event.sentBytes)).toEqual([
      0,
      Math.floor(received.bytes / 3),
      Math.floor((2 * received.bytes) / 3),
      received.bytes,
    ]);
    expect(events.every((event) => event.totalBytes === received.bytes)).toBe(true);
    // The Ky client defaults to `credentials: 'include'`; bare fetch leaves it same-origin.
    expect(received.cookie).toBe(name === 'Ky client' ? 'include' : 'same-origin');
  });

  test('an error envelope still arrives as its ApiError', async () => {
    const failure = await makeClient()
      .busy.withOptions({ text: 'a' }, { onUploadProgress: () => undefined })
      .catch((error: unknown) => error);
    expect(ApiError.is(failure)).toBe(true);
    if (!ApiError.is(failure)) return;
    expect(failure.code).toBe('BUSY');
    expect(failure.status).toBe(503);
    expect(failure.message).toBe('try later');
  });

  test('a 204 answer is an empty result', async () => {
    const result = await makeClient().forget.withOptions(
      { text: 'a' },
      { onUploadProgress: () => undefined },
    );
    expect(result).toBeUndefined();
  });

  test('the caller signal aborts the XHR', async () => {
    RelayXhr.opened = [];
    RelayXhr.hold = true;
    const controller = new AbortController();
    const pending = makeClient()
      .upload.withOptions(
        { file: FILE },
        { signal: controller.signal, onUploadProgress: () => undefined },
      )
      .catch((error: unknown) => error);
    await Bun.sleep(5);
    controller.abort();
    const failure = await pending;
    RelayXhr.hold = false;
    expect(RelayXhr.opened[0]?.aborted).toBe(true);
    expect(ApiError.is(failure) && failure.code).toBe('REQUEST_ABORTED');
  });
});

test("credentials 'omit' is refused: XHR cannot drop same-origin cookies", async () => {
  const failure = await createClient(contract, { baseUrl, credentials: 'omit' })
    .busy.withOptions({ text: 'a' }, { onUploadProgress: () => undefined })
    .catch((error: unknown) => error);
  expect(ApiError.is(failure) && failure.code).toBe('UNKNOWN_ERROR');
  expect(ApiError.is(failure) && failure.message).toContain('cannot omit same-origin cookies');
});

test('an injected fetch is used even where XMLHttpRequest exists', async () => {
  RelayXhr.opened = [];
  let calls = 0;
  const received = await createClient(contract, {
    baseUrl,
    fetch: (input, init) => {
      calls += 1;
      return fetch(input, init);
    },
  }).upload.withOptions({ file: FILE }, { onUploadProgress: () => undefined });
  expect(calls).toBe(1);
  expect(RelayXhr.opened).toHaveLength(0);
  expect(received.bytes).toBeGreaterThan(FILE.size);
});
