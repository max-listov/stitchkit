import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createRequestCancellation,
  RequestCancellationError,
} from '../src/browser/cancellation';
import { createClient } from '../src/browser/client';
import { ApiError, createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';

const contract = defineContract(
  { prefix: 'slow' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Slow ping',
      output: z.object({ ok: z.boolean() }),
    },
    search: {
      method: 'GET',
      path: '/search',
      desc: 'Slow search',
      input: z.object({ query: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    create: {
      method: 'POST',
      path: '/create',
      desc: 'Slow create',
      input: z.object({ value: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Slow upload',
      multipart: { files: { file: {} } },
      output: z.object({ ok: z.boolean() }),
    },
    download: {
      method: 'GET',
      path: '/download',
      desc: 'Slow download',
      rawResponse: true,
    },
    timeout: {
      method: 'GET',
      path: '/timeout',
      desc: 'Timeout probe',
      timeout: 5,
      output: z.object({ ok: z.boolean() }),
    },
  },
);

let requests = 0;
const server = Bun.serve({
  port: 0,
  async fetch() {
    requests += 1;
    await Bun.sleep(100);
    return Response.json({ ok: true });
  },
});
const baseUrl = `http://localhost:${server.port}`;

afterAll(() => server.stop(true));

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`Expected ${code}`);
    },
    (error: unknown) => {
      expect(ApiError.is(error)).toBe(true);
      if (!ApiError.is(error)) throw error;
      expect(error.code).toBe(code);
      expect(error.status).toBe(0);
    },
  );
}

describe.each([
  ['bare fetch', () => createClient(contract, { baseUrl })],
  [
    'Ky adapter',
    () => createClient(contract, createHttpClient({ baseUrl, retry: { limit: 0 } })),
  ],
])('typed client cancellation — %s', (_name, makeClient) => {
  test('caller abort cancels GET, JSON, multipart and raw-response calls', async () => {
    const api = makeClient();
    const cases: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (signal) => api.search({ query: 'value' }, { signal }),
      (signal) => api.create({ value: 'value' }, { signal }),
      (signal) => api.upload({ file: new File(['data'], 'data.txt') }, { signal }),
      (signal) => api.download({ signal }),
    ];
    for (const call of cases) {
      const controller = new AbortController();
      const pending = call(controller.signal);
      controller.abort('cancelled by caller');
      await expectCode(pending, 'REQUEST_ABORTED');
    }
  });

  test('an already-aborted signal never sends the request', async () => {
    const api = makeClient();
    const before = requests;
    const controller = new AbortController();
    controller.abort();
    await expectCode(api.ping({ signal: controller.signal }), 'REQUEST_ABORTED');
    await Bun.sleep(10);
    expect(requests).toBe(before);
  });

  test('endpoint timeout is distinct from caller cancellation', async () => {
    const api = makeClient();
    await expectCode(api.timeout(), 'REQUEST_TIMEOUT');
  });
});

test('abort and timeout do not emit Ky network_error events', async () => {
  const events: string[] = [];
  const http = createHttpClient({ baseUrl, retry: { limit: 0 } });
  http.subscribe((event) => void events.push(event.type));
  const api = createClient(contract, http);
  const controller = new AbortController();
  const pending = api.ping({ signal: controller.signal });
  controller.abort();
  await expectCode(pending, 'REQUEST_ABORTED');
  await expectCode(api.timeout(), 'REQUEST_TIMEOUT');
  expect(events).toEqual([]);
});

function waitForCancellation(signal?: AbortSignal): Promise<void> {
  if (!signal) throw new Error('Expected a composed cancellation signal');
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('the first cancellation cause wins the caller/timeout race', async () => {
  const callerFirst = new AbortController();
  const callerCancellation = createRequestCancellation(callerFirst.signal, 100);
  const callerPending = callerCancellation.run(waitForCancellation);
  callerFirst.abort();
  await expect(callerPending).rejects.toBeInstanceOf(RequestCancellationError);
  await callerPending.catch((error: unknown) => {
    expect(error).toBeInstanceOf(RequestCancellationError);
    if (error instanceof RequestCancellationError) expect(error.cause).toBe('caller');
  });

  const timeoutFirst = new AbortController();
  const timeoutCancellation = createRequestCancellation(timeoutFirst.signal, 1);
  const timeoutPending = timeoutCancellation.run(waitForCancellation);
  await timeoutPending.catch((error: unknown) => {
    expect(error).toBeInstanceOf(RequestCancellationError);
    if (error instanceof RequestCancellationError) expect(error.cause).toBe('timeout');
  });
  timeoutFirst.abort();
});

// Compile-time surface: no-arg endpoints accept options directly; endpoints
// with arguments keep request args first and options second.
function compileTimeCancellationChecks(): void {
  const typeClient = createClient(contract, { baseUrl: 'http://localhost' });
  const typeSignal = new AbortController().signal;
  void typeClient.ping({ signal: typeSignal });
  void typeClient.create({ value: 'ok' }, { signal: typeSignal });
  // @ts-expect-error request options are not endpoint input
  void typeClient.create({ signal: typeSignal });
  // @ts-expect-error no-arg endpoint has no separate args object
  void typeClient.ping({}, { signal: typeSignal });
}
void compileTimeCancellationChecks;
