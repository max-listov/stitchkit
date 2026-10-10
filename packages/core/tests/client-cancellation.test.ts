import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import {
  createRequestCancellation,
  RequestCancellationError,
} from '../src/browser/cancellation';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import type { ClientFetch } from '../src/browser/transport';
import { defineContract } from '../src/entrypoints/contract';

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
    stream: {
      method: 'GET',
      path: '/stream',
      desc: 'Streaming cancellation probe',
      timeout: 5,
      stream: { item: z.object({ ok: z.boolean() }) },
    },
  },
);

const requestsByPath = new Map<string, number>();
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    requestsByPath.set(path, (requestsByPath.get(path) ?? 0) + 1);
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

function requestCount(path: string): number {
  return requestsByPath.get(path) ?? 0;
}

describe.each([
  ['bare fetch', () => createClient(contract, { baseUrl }), () => ({ baseUrl })],
  [
    'Ky adapter',
    () => createClient(contract, createHttpClient({ baseUrl, retry: { limit: 0 } })),
    () => createHttpClient({ baseUrl, retry: { limit: 0 } }),
  ],
])('typed client cancellation — %s', (_name, makeClient, makeTransport) => {
  test('caller abort cancels GET, JSON, multipart and raw-response calls', async () => {
    const api = makeClient();
    const cases: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (signal) => api.search.withOptions({ query: 'value' }, { signal }),
      (signal) => api.create.withOptions({ value: 'value' }, { signal }),
      (signal) => api.upload.withOptions({ file: new File(['data'], 'data.txt') }, { signal }),
      (signal) => api.download.withOptions({ signal }),
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
    const before = requestCount('/slow/ping');
    const controller = new AbortController();
    controller.abort();
    await expectCode(api.ping.withOptions({ signal: controller.signal }), 'REQUEST_ABORTED');
    await Bun.sleep(10);
    expect(requestCount('/slow/ping')).toBe(before);
  });

  test('scoped methods preserve cancellation without sending prefix keys', async () => {
    const scoped = createClient(contract, makeTransport(), {
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
      stripPrefixKeys: ['tenantId'],
    });
    const before = requestCount('/tenants/tenant-1/slow/create');
    const controller = new AbortController();
    controller.abort();
    await expectCode(
      scoped.create.withOptions(
        { tenantId: 'tenant-1', value: 'value' },
        { signal: controller.signal },
      ),
      'REQUEST_ABORTED',
    );
    await Bun.sleep(10);
    expect(requestCount('/tenants/tenant-1/slow/create')).toBe(before);
  });

  test('ordinary callables ignore foreign callback context completely', async () => {
    const api = makeClient();
    const foreignContext = Object.defineProperty({}, 'signal', {
      get() {
        throw new Error('foreign callback context was read');
      },
    });

    await expect(
      Reflect.apply(api.create, undefined, [{ value: 'value' }, foreignContext]),
    ).resolves.toEqual({ ok: true });
    await expect(
      Reflect.apply(api.ping, undefined, [undefined, foreignContext]),
    ).resolves.toEqual({
      ok: true,
    });
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
  const pending = api.ping.withOptions({ signal: controller.signal });
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
    if (error instanceof RequestCancellationError) expect(error.origin).toBe('caller');
  });

  const timeoutFirst = new AbortController();
  const timeoutCancellation = createRequestCancellation(timeoutFirst.signal, 1);
  const timeoutPending = timeoutCancellation.run(waitForCancellation);
  await timeoutPending.catch((error: unknown) => {
    expect(error).toBeInstanceOf(RequestCancellationError);
    if (error instanceof RequestCancellationError) expect(error.origin).toBe('timeout');
  });
  timeoutFirst.abort();
});

test('a streaming open keeps an earlier caller origin when its transport rejects after the timeout', async () => {
  const evidence = new Error('transport closed after cancellation');
  const transport: ClientFetch = (input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!signal) throw new Error('Expected a transport signal');
      const rejectLater = (): void => {
        setTimeout(() => reject(evidence), 15);
      };
      if (signal.aborted) rejectLater();
      else signal.addEventListener('abort', rejectLater, { once: true });
    });
  const api = createClient(contract, { baseUrl, fetch: transport });
  const controller = new AbortController();
  const pending = api.stream.withOptions({ signal: controller.signal });
  controller.abort();
  const failure = await pending.catch((error: unknown) => error);
  expect(ApiError.is(failure)).toBe(true);
  if (!ApiError.is(failure)) throw failure;
  expect(failure.code).toBe('REQUEST_ABORTED');
  expect(failure.cause).toBe(evidence);
});

class TransportEvidence extends Error {
  readonly delivery = 'not-dispatched';
  readonly traceId = 'private-trace';
}

function rejectOnAbort(failure: Error): ClientFetch {
  return (input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!signal) throw new Error('Expected a transport signal');
      if (signal.aborted) {
        reject(failure);
        return;
      }
      signal.addEventListener('abort', () => reject(failure), { once: true });
    });
}

function chainIncludes(error: unknown, expected: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    if (current === expected) return true;
    visited.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

describe.each([
  [
    'bare fetch',
    (transport: ClientFetch) => createClient(contract, { baseUrl, fetch: transport }),
  ],
  [
    'Ky adapter',
    (transport: ClientFetch) =>
      createClient(
        contract,
        createHttpClient({ baseUrl, fetch: transport, retry: { limit: 0 } }),
      ),
  ],
])('typed client cancellation evidence — %s', (_name, makeClientWith) => {
  test.each([['caller', 'REQUEST_ABORTED'] as const, ['timeout', 'REQUEST_TIMEOUT'] as const])(
    '%s cancellation keeps the transport cause without exposing it publicly',
    async (kind, code) => {
      const evidence = new TransportEvidence('credential=must-not-be-public');
      const api = makeClientWith(rejectOnAbort(evidence));
      const controller = new AbortController();
      const pending =
        kind === 'caller'
          ? api.ping.withOptions({ signal: controller.signal })
          : api.timeout();
      if (kind === 'caller') controller.abort();
      const failure = await pending.catch((error: unknown) => error);
      expect(ApiError.is(failure)).toBe(true);
      if (!ApiError.is(failure)) throw failure;
      expect(failure.code).toBe(code);
      expect(chainIncludes(failure, evidence)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('must-not-be-public');
      expect(failure.message).not.toContain('must-not-be-public');
    },
  );

  test('a successful custom transport is unchanged', async () => {
    const api = makeClientWith(async () => Response.json({ ok: true }));
    await expect(api.ping()).resolves.toEqual({ ok: true });
  });
});

// Compile-time surface: ordinary calls carry only contract arguments; transport
// options live exclusively on the callable's explicit method.
function compileTimeCancellationChecks(): void {
  const typeClient = createClient(contract, { baseUrl: 'http://localhost' });
  const typeSignal = new AbortController().signal;
  void typeClient.ping.withOptions({ signal: typeSignal });
  void typeClient.create.withOptions({ value: 'ok' }, { signal: typeSignal });
  // @ts-expect-error positional request options were removed
  void typeClient.create({ value: 'ok' }, { signal: typeSignal });
  // @ts-expect-error no-argument endpoints accept no ordinary-call options
  void typeClient.ping({ signal: typeSignal });
  // @ts-expect-error request options are not endpoint input
  void typeClient.create({ signal: typeSignal });
}
void compileTimeCancellationChecks;
