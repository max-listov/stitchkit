/**
 * `onUploadProgress` in React Native: the runtime says `navigator.product ===
 * 'ReactNative'`, and the body goes to its `XMLHttpRequest` as the client built
 * it — the same `FormData` object, never bytes read out of it, since a React
 * Native file part is a `{ uri, name, type }` the platform streams from disk.
 * A stand-in XHR encodes what it is handed, reports upload events the way the
 * platform does and relays the request to a real server; what it proves is
 * the wiring, not a device's network stack.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// @ts-expect-error -- RN's fetch package ships Flow types, not TypeScript declarations.
import * as rnFetch from 'whatwg-fetch';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import type { UploadProgress } from '../src/contract/client-types';
import { defineContract } from '../src/entrypoints/contract';

const contract = defineContract(
  { prefix: 'native' },
  {
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Receive a file',
      multipart: { files: { file: {} } },
      output: z.object({ bytes: z.number(), cookie: z.string().nullable() }),
    },
    note: {
      method: 'POST',
      path: '/note',
      desc: 'Receive JSON',
      input: z.object({ text: z.string() }),
      output: z.object({ bytes: z.number(), cookie: z.string().nullable() }),
    },
    say: {
      method: 'POST',
      path: '/say',
      desc: 'Echo the message',
      input: z.object({ message: z.string() }),
      output: z.object({ message: z.string() }),
    },
    raw: {
      method: 'POST',
      path: '/raw',
      desc: 'Choose a binary or empty reply',
      input: z.object({ empty: z.boolean() }),
      rawResponse: true,
    },
    busy: {
      method: 'POST',
      path: '/busy',
      desc: 'Refuse with an envelope',
      input: z.object({ text: z.string() }),
      output: z.object({ bytes: z.number() }),
    },
  },
);

const WebResponse = Response;
const WebRequest = Request;
const WebHeaders = Headers;
const binary = new Uint8Array([0, 255, 195, 40, 128]);
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/say')) {
      return WebResponse.json(await request.json());
    }
    if (path.endsWith('/raw')) {
      if ((await request.json()).empty) return new WebResponse(null, { status: 204 });
      return new WebResponse(binary, {
        status: 201,
        headers: { 'content-type': 'application/octet-stream', 'x-receipt': 'upload:1' },
      });
    }
    const bytes = (await request.arrayBuffer()).byteLength;
    if (path.endsWith('/busy')) {
      return WebResponse.json(
        { error: { code: 'BUSY', message: 'Занято ⏳' } },
        {
          status: 503,
          headers: { 'x-request-id': 'native-busy' },
        },
      );
    }
    return WebResponse.json({ bytes, cookie: request.headers.get('x-cookie-mode') });
  },
});
const baseUrl = `http://localhost:${server.port}`;

interface ProgressEventLike {
  loaded: number;
  total: number;
}

/** React Native's XHR as the client sees it: it encodes the body itself. */
class NativeXhr {
  static opened: NativeXhr[] = [];
  method = '';
  url = '';
  readonly headers = new Map<string, string>();
  // React Native's default: the platform keeps cookies unless told not to.
  withCredentials = true;
  responseType = '';
  status = 0;
  statusText = '';
  response: unknown = null;
  sent: unknown = undefined;
  private responseHeaders = '';
  readonly upload: { onprogress?: (event: ProgressEventLike) => void; onload?: () => void } =
    {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    NativeXhr.opened.push(this);
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  abort(): void {
    this.onabort?.();
  }

  send(body: unknown): void {
    this.sent = body;
    void this.relay(body);
  }

  private async relay(body: unknown): Promise<void> {
    await Bun.sleep(1);
    const encoded = new WebRequest(this.url, {
      method: this.method,
      headers: [...this.headers],
      body: body instanceof FormData || typeof body === 'string' ? body : null,
    });
    const headers = new WebHeaders(encoded.headers);
    const bytes = await encoded.arrayBuffer();
    const total = bytes.byteLength;
    for (const loaded of [Math.floor(total / 3), Math.floor((2 * total) / 3), total]) {
      this.upload.onprogress?.({ loaded, total });
    }
    this.upload.onload?.();
    headers.set('x-cookie-mode', String(this.withCredentials));
    const response = await fetch(this.url, { method: this.method, headers, body: bytes });
    this.status = response.status;
    this.statusText = response.statusText;
    this.responseHeaders = [...response.headers]
      .map(([name, value]) => `${name}: ${value}`)
      .join('\r\n');
    this.response =
      this.responseType === 'text' ? await response.text() : await response.arrayBuffer();
    this.onload?.();
  }
}

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const realXhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
beforeAll(() => {
  globalThis.Response = rnFetch.Response;
  globalThis.Request = rnFetch.Request;
  globalThis.Headers = rnFetch.Headers;
  Reflect.set(globalThis, 'XMLHttpRequest', NativeXhr);
  Object.defineProperty(globalThis, 'navigator', {
    value: { product: 'ReactNative' },
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  globalThis.Response = WebResponse;
  globalThis.Request = WebRequest;
  globalThis.Headers = WebHeaders;
  if (realXhr) Object.defineProperty(globalThis, 'XMLHttpRequest', realXhr);
  else Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
  server.stop(true);
});

const FILE = new File([new Uint8Array(90_000).fill(5)], 'take.m4a', { type: 'audio/mp4' });

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

describe.each(transports)('the React Native route of the %s', (_name, makeClient) => {
  test('hands the platform the FormData itself and counts 0 → total', async () => {
    NativeXhr.opened = [];
    const { events, listen } = recorder();
    const received = await makeClient().upload.withOptions(
      { file: FILE },
      { onUploadProgress: listen },
    );
    const [xhr] = NativeXhr.opened;
    expect(xhr?.sent).toBeInstanceOf(FormData);
    expect(xhr?.sent instanceof FormData && xhr.sent.get('file')).toBeInstanceOf(Blob);
    // The platform writes the multipart boundary; the client must not.
    expect(xhr?.headers.has('content-type')).toBe(false);
    expect(events.map((event) => event.sentBytes)).toEqual([
      0,
      Math.floor(received.bytes / 3),
      Math.floor((2 * received.bytes) / 3),
      received.bytes,
    ]);
    expect(events.every((event) => event.totalBytes === received.bytes)).toBe(true);
  });

  test('a JSON body is sent as its string, its length known from the start', async () => {
    NativeXhr.opened = [];
    const { events, listen } = recorder();
    const received = await makeClient().note.withOptions(
      { text: 'привет' },
      { onUploadProgress: listen },
    );
    const [xhr] = NativeXhr.opened;
    expect(xhr?.sent).toBe(JSON.stringify({ text: 'привет' }));
    expect(xhr?.headers.get('content-type')).toStartWith('application/json');
    expect(events[0]).toEqual({ sentBytes: 0, totalBytes: received.bytes, attempt: 1 });
    expect(events.at(-1)?.sentBytes).toBe(received.bytes);
  });

  test('an error envelope still arrives as its ApiError', async () => {
    const failure = await makeClient()
      .busy.withOptions({ text: 'a' }, { onUploadProgress: () => undefined })
      .catch((error: unknown) => error);
    expect(
      ApiError.is(failure) && [failure.code, failure.status, failure.message, failure.traceId],
    ).toEqual(['BUSY', 503, 'Занято ⏳', 'native-busy']);
  });

  test('upload progress preserves the Unicode echo in the React Native Response', async () => {
    const message = `${'a'.repeat(200_000)}Привет! 🚀`;
    const totalBytes = new TextEncoder().encode(JSON.stringify({ message })).length;
    const client = makeClient();
    const { listen, events } = recorder();
    const { message: echo } = await client.say.withOptions(
      { message },
      { onUploadProgress: listen },
    );
    expect(events[0]).toEqual({ attempt: 1, sentBytes: 0, totalBytes });
    expect(events.at(-1)).toEqual({ attempt: 1, sentBytes: totalBytes, totalBytes });
    expect(echo.length).toBe(message.length);
    expect(echo === message).toBe(true);
  });

  test('raw upload responses retain non-UTF-8 bytes, headers, status and an empty 204', async () => {
    const client = makeClient();
    const options = { onUploadProgress: () => undefined };
    const response = await client.raw.withOptions({ empty: false }, options);
    expect([response.status, response.statusText]).toEqual([201, 'Created']);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-receipt')).toBe('upload:1');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary);
    const empty = await client.raw.withOptions({ empty: true }, options);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
  });
});

describe('credentials and transport on React Native', () => {
  test("credentials follow React Native's fetch: omit and include set it, else the default", async () => {
    const withCredentials = async (
      credentials?: RequestCredentials,
    ): Promise<string | null> => {
      const api = createClient(contract, { baseUrl, ...(credentials && { credentials }) });
      const { cookie } = await api.note.withOptions(
        { text: 'a' },
        { onUploadProgress: () => undefined },
      );
      return cookie;
    };
    expect(await withCredentials('omit')).toBe('false');
    expect(await withCredentials('include')).toBe('true');
    expect(await withCredentials('same-origin')).toBe('true');
  });

  test('an injected fetch is refused: React Native cannot stream a body to count', async () => {
    const api = createClient(contract, {
      baseUrl,
      fetch: (input, init) => fetch(input, init),
    });
    const failure = await api.note
      .withOptions({ text: 'a' }, { onUploadProgress: () => undefined })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain('React Native');
    // Without the option the injected fetch serves as always.
    expect(await api.note({ text: 'a' })).toEqual({ bytes: 12, cookie: null });
  });

  test('refusing an injected fetch with onUploadProgress does not start or leak a request timeout timer', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      scheduled += 1;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;
    try {
      const api = createClient(contract, {
        baseUrl,
        fetch: (input, init) => fetch(input, init),
        timeout: 60_000,
      });
      await expect(
        api.note.withOptions({ text: 'a' }, { onUploadProgress: () => undefined }),
      ).rejects.toThrow(TypeError);
      expect(scheduled).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
