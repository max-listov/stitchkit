/**
 * `onUploadProgress`: both client transports report the body leaving — first
 * `0`, growing, last equal to the encoded length the server received — a retry
 * counts again under the next attempt, and a call without the option reaches
 * the transport exactly as before.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import type { ClientFetch } from '../src/browser/transport';
import type { UploadProgress } from '../src/contract/client-types';
import { defineContract } from '../src/entrypoints/contract';
import { createUnixClientTransport } from '../src/server/unix-client';

const Received = z.object({
  bytes: z.number(),
  declared: z.string().nullable(),
  file: z.number(),
  attempt: z.number(),
});

const contract = defineContract(
  { prefix: 'progress' },
  {
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Receive a file',
      multipart: { files: { file: {} } },
      input: z.object({ title: z.string() }),
      output: Received,
    },
    note: {
      method: 'PUT',
      path: '/note',
      desc: 'Receive JSON',
      input: z.object({ text: z.string() }),
      output: Received,
    },
    flaky: {
      method: 'POST',
      path: '/flaky',
      desc: 'Refuse the first attempt with 503',
      input: z.object({ text: z.string() }),
      output: Received,
    },
    read: {
      method: 'GET',
      path: '/read',
      desc: 'No body',
      output: Received,
    },
  },
);

let flakyAttempts = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const declared = request.headers.get('content-length');
    const contentType = request.headers.get('content-type') ?? '';
    const body = new Uint8Array(await request.arrayBuffer());
    let file = 0;
    if (contentType.startsWith('multipart/form-data')) {
      const form = await new Response(body, {
        headers: { 'content-type': contentType },
      }).formData();
      const part = form.get('file');
      file = part instanceof Blob ? part.size : -1;
    }
    if (path.endsWith('/flaky')) {
      flakyAttempts += 1;
      if (flakyAttempts === 1)
        return Response.json({ error: { code: 'BUSY' } }, { status: 503 });
    }
    return Response.json({ bytes: body.byteLength, declared, file, attempt: flakyAttempts });
  },
});
const baseUrl = `http://localhost:${server.port}`;
const socketPath = join(mkdtempSync(join(tmpdir(), 'sk-progress-')), 'api.sock');
const unixServer = Bun.serve({ unix: socketPath, fetch: (request) => server.fetch(request) });
afterAll(() => {
  server.stop(true);
  unixServer.stop(true);
  rmSync(dirname(socketPath), { recursive: true, force: true });
});

const FILE = new File([new Uint8Array(300 * 1024).fill(7)], 'take.webm', {
  type: 'audio/webm',
});

function recorder(): { events: UploadProgress[]; listen: (progress: UploadProgress) => void } {
  const events: UploadProgress[] = [];
  return { events, listen: (progress) => events.push(progress) };
}

/** First 0, strictly growing, last equal to the total, one total per attempt. */
function expectCompleteCount(events: readonly UploadProgress[], totalBytes: number): void {
  expect(events.length).toBeGreaterThan(2);
  expect(events[0]).toEqual({ sentBytes: 0, totalBytes, attempt: 1 });
  expect(events.at(-1)).toEqual({ sentBytes: totalBytes, totalBytes, attempt: 1 });
  for (const [index, event] of events.entries()) {
    expect(event.totalBytes).toBe(totalBytes);
    const previous = events[index - 1];
    if (previous) expect(event.sentBytes).toBeGreaterThan(previous.sentBytes);
  }
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

describe.each(transports)('onUploadProgress over the %s', (_name, makeClient) => {
  test('a 300 KB multipart body is counted to the length the server received', async () => {
    const { events, listen } = recorder();
    const received = await makeClient().upload.withOptions(
      { file: FILE, title: 'take' },
      { onUploadProgress: listen },
    );
    expect(received.file).toBe(FILE.size);
    expect(received.declared).toBe(String(received.bytes));
    expectCompleteCount(events, received.bytes);
  });

  test('a JSON body is counted too', async () => {
    const { events, listen } = recorder();
    const text = 'x'.repeat(200_000);
    const received = await makeClient().note.withOptions(
      { text },
      { onUploadProgress: listen },
    );
    expect(received.bytes).toBe(JSON.stringify({ text }).length);
    expectCompleteCount(events, received.bytes);
  });

  test('a method without a body refuses the option at the call site', () => {
    expect(() => makeClient().read.withOptions({ onUploadProgress: () => undefined })).toThrow(
      'onUploadProgress needs a request body',
    );
  });

  test('a non-function listener is a programming error', () => {
    // An untyped call site: JavaScript, a generated wrapper, dynamic dispatch.
    const { withOptions } = makeClient().note;
    expect(() =>
      Reflect.apply(withOptions, undefined, [{ text: 'a' }, { onUploadProgress: 'yes' }]),
    ).toThrow('onUploadProgress must be a function');
  });
});

describe('the path without the option', () => {
  test('the bare-fetch transport still receives the FormData itself', async () => {
    const seen: unknown[] = [];
    const spy: ClientFetch = (input, init) => {
      seen.push(init?.body);
      return fetch(input, init);
    };
    await createClient(contract, { baseUrl, fetch: spy }).upload({ file: FILE, title: 't' });
    expect(seen[0]).toBeInstanceOf(FormData);
  });

  test('the Ky transport still receives its own Request with no content-length set', async () => {
    const seen: unknown[] = [];
    const spy: ClientFetch = (input, init) => {
      seen.push(input);
      return fetch(input, init);
    };
    await createClient(contract, createHttpClient({ baseUrl, fetch: spy })).upload({
      file: FILE,
      title: 't',
    });
    const [first] = seen;
    expect(first).toBeInstanceOf(Request);
    if (first instanceof Request) expect(first.headers.get('content-length')).toBeNull();
  });
});

describe('an injected transport and a retry', () => {
  test('an injected fetch receives the counted stream and pulls it', async () => {
    const { events, listen } = recorder();
    const bodies: unknown[] = [];
    const spy: ClientFetch = (input, init) => {
      bodies.push(init?.body);
      return fetch(input, init);
    };
    const received = await createClient(contract, { baseUrl, fetch: spy }).note.withOptions(
      { text: 'y'.repeat(150_000) },
      { onUploadProgress: listen },
    );
    expect(bodies[0]).toBeInstanceOf(ReadableStream);
    expectCompleteCount(events, received.bytes);
  });

  test('a retried 503 counts the body again under attempt 2', async () => {
    flakyAttempts = 0;
    const { events, listen } = recorder();
    const client = createClient(
      contract,
      createHttpClient({
        baseUrl,
        retry: { limit: 1, methods: ['post'], statusCodes: [503] },
      }),
    );
    const received = await client.flaky.withOptions(
      { text: 'z'.repeat(100_000) },
      { onUploadProgress: listen },
    );
    expect(received.attempt).toBe(2);
    const second = events.findIndex((event) => event.attempt === 2);
    expect(second).toBeGreaterThan(0);
    expect(events[second - 1]).toEqual({
      sentBytes: received.bytes,
      totalBytes: received.bytes,
      attempt: 1,
    });
    expect(events[second]).toEqual({ sentBytes: 0, totalBytes: received.bytes, attempt: 2 });
    expect(events.at(-1)).toEqual({
      sentBytes: received.bytes,
      totalBytes: received.bytes,
      attempt: 2,
    });
  });

  test('a listener that throws does not fail the upload', async () => {
    const received = await createClient(contract, { baseUrl }).note.withOptions(
      { text: 'ok' },
      {
        onUploadProgress: () => {
          throw new Error('view broke');
        },
      },
    );
    expect(received.bytes).toBeGreaterThan(0);
  });
});

describe('over a unix socket', () => {
  test("Bun's own socket dial (`unix`) streams the counted body", async () => {
    const { events, listen } = recorder();
    const client = createClient(
      contract,
      createHttpClient({ baseUrl: 'http://localhost', unix: socketPath }),
    );
    const received = await client.upload.withOptions(
      { file: FILE, title: 'take' },
      { onUploadProgress: listen },
    );
    expect(received.file).toBe(FILE.size);
    expectCompleteCount(events, received.bytes);
  });

  test('the portable unix transport receives and sends the whole counted body', async () => {
    const { events, listen } = recorder();
    const transport = createUnixClientTransport({ socketPath });
    try {
      const client = createClient(contract, {
        baseUrl: 'http://localhost',
        fetch: transport.fetch,
      });
      const received = await client.upload.withOptions(
        { file: FILE, title: 'take' },
        { onUploadProgress: listen },
      );
      expect(received.file).toBe(FILE.size);
      expectCompleteCount(events, received.bytes);
    } finally {
      await transport.close();
    }
  });
});
