import { describe, expect, spyOn, test } from 'bun:test';
import { createConnection, type Socket } from 'node:net';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import {
  createObservability,
  createTraceContext,
  type RequestContext,
  type RequestEvent,
} from '../src/observability';
import {
  createHandler,
  createServer,
  implement,
  type RawRoute,
  type StitchLogger,
} from '../src/server';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface LogRow {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function recordingLogger(rows: LogRow[], completed?: Deferred): StitchLogger {
  const record =
    (level: LogRow['level']) =>
    (message: string, fields?: Record<string, unknown>): void => {
      const row = { level, message, fields: fields ?? {} };
      rows.push(row);
      if (row.fields.status === 499) completed?.resolve();
    };
  return {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

function completionRows(rows: LogRow[]): LogRow[] {
  return rows.filter((row) => typeof row.fields.status === 'number');
}

function abortingRawRoute(error: unknown): RawRoute {
  return {
    method: 'GET',
    path: '/work',
    handler: () => {
      throw error;
    },
  };
}

function waitForRequestAbort(req: Request, observed: Deferred): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectWithReason = (): void => {
      observed.resolve();
      reject(req.signal.reason ?? new DOMException('The connection was closed', 'AbortError'));
    };
    if (req.signal.aborted) rejectWithReason();
    else req.signal.addEventListener('abort', rejectWithReason, { once: true });
  });
}

function connectRaw(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const fail = (error: Error): void => reject(error);
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.off('error', fail);
      socket.on('error', () => undefined);
      resolve(socket);
    });
  });
}

function requestContext(path: string): RequestContext {
  return {
    source: 'http',
    method: 'GET',
    path,
    startedAt: process.hrtime.bigint(),
    trace: createTraceContext(),
  };
}

describe('client-closed HTTP request classification', () => {
  test('an aborted request plus AbortError bypasses the application error pipeline', async () => {
    const controller = new AbortController();
    const error = new DOMException('The connection was closed', 'AbortError');
    const request = new Request('http://localhost/work', { signal: controller.signal });
    controller.abort(error);
    const logs: LogRow[] = [];
    const events: RequestEvent[] = [];
    let onErrorCalls = 0;
    const observability = createObservability({
      request: { write: (event) => void events.push(event) },
    });
    const handler = createHandler({
      rawRoutes: [abortingRawRoute(error)],
      logging: { logger: recordingLogger(logs) },
      observability: observability.request,
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return undefined;
        },
      },
    });
    const diagnostic = spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await handler(request);
      await observability.flush();

      expect(response.status).toBe(499);
      expect(response.statusText).toBe('Client Closed Request');
      expect(await response.text()).toBe('');
      expect(onErrorCalls).toBe(0);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(observability.getStatus().request?.received).toBe(0);
      expect(completionRows(logs)).toEqual([
        expect.objectContaining({
          level: 'info',
          fields: expect.objectContaining({ status: 499 }),
        }),
      ]);
      expect(Object.hasOwn(completionRows(logs)[0]?.fields ?? {}, 'errorCode')).toBe(false);
    } finally {
      diagnostic.mockRestore();
      await observability.close();
    }
  });

  test('an opted-in request sink receives one structured cancellation row', async () => {
    const controller = new AbortController();
    const error = new DOMException('closed', 'AbortError');
    const request = new Request('http://localhost/work', { signal: controller.signal });
    controller.abort(error);
    const events: RequestEvent[] = [];
    const observability = createObservability({
      request: {
        includeCancelled: true,
        write: (event) => void events.push(event),
      },
    });
    const handler = createHandler({
      rawRoutes: [abortingRawRoute(error)],
      observability: observability.request,
    });

    const response = await handler(request);
    await observability.flush();

    expect(response.status).toBe(499);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'http',
      method: 'GET',
      path: '/work',
      outcome: 'cancelled',
      ok: false,
      statusCode: 499,
      payload: null,
    });
    expect(Object.hasOwn(events[0] ?? {}, 'errorCode')).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, 'errorMessage')).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, 'errorDetail')).toBe(false);
    expect(observability.getStatus().request).toMatchObject({
      received: 1,
      accepted: 1,
      completed: 1,
    });
    await observability.close();
  });

  test('AbortError with an active request signal remains an internal failure', async () => {
    const error = new DOMException('internal abort', 'AbortError');
    const logs: LogRow[] = [];
    const events: RequestEvent[] = [];
    let onErrorCalls = 0;
    const observability = createObservability({
      request: { write: (event) => void events.push(event) },
    });
    const handler = createHandler({
      rawRoutes: [abortingRawRoute(error)],
      logging: { logger: recordingLogger(logs) },
      observability: observability.request,
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return undefined;
        },
      },
    });
    const diagnostic = spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await handler(new Request('http://localhost/work'));
      await observability.flush();

      expect(response.status).toBe(500);
      expect(onErrorCalls).toBe(1);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(completionRows(logs)[0]).toMatchObject({
        level: 'error',
        fields: expect.objectContaining({
          status: 500,
          errorCode: 'INTERNAL_SERVER_ERROR',
        }),
      });
      expect(events[0]).toMatchObject({
        ok: false,
        statusCode: 500,
        errorCode: 'INTERNAL_SERVER_ERROR',
      });
      expect(events[0]?.outcome).toBeUndefined();
    } finally {
      diagnostic.mockRestore();
      await observability.close();
    }
  });

  test('an aborted request with a non-AbortError keeps the ordinary error path', async () => {
    const controller = new AbortController();
    const request = new Request('http://localhost/work', { signal: controller.signal });
    controller.abort(new DOMException('closed', 'AbortError'));
    let onErrorCalls = 0;
    const handler = createHandler({
      rawRoutes: [abortingRawRoute(new Error('database failed'))],
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return new Response('handled', { status: 503 });
        },
      },
    });

    const response = await handler(request);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('handled');
    expect(onErrorCalls).toBe(1);
  });

  test('a runtime-specific request abort reason is recognized by exact identity', async () => {
    const controller = new AbortController();
    const transportReason = new Error('aborted');
    const request = new Request('http://localhost/work', { signal: controller.signal });
    controller.abort(transportReason);
    let onErrorCalls = 0;
    const handler = createHandler({
      rawRoutes: [abortingRawRoute(transportReason)],
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return undefined;
        },
      },
    });

    const response = await handler(request);

    expect(response.status).toBe(499);
    expect(onErrorCalls).toBe(0);
  });

  test('a wrapped runtime abort reason is recognized through the standard cause chain', async () => {
    const controller = new AbortController();
    const transportReason = new Error('aborted');
    const wrapped = new Error('query cancelled', {
      cause: new Error('driver cancelled', { cause: transportReason }),
    });
    const request = new Request('http://localhost/work', { signal: controller.signal });
    controller.abort(transportReason);
    let onErrorCalls = 0;
    const handler = createHandler({
      rawRoutes: [abortingRawRoute(wrapped)],
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return new Response('handled', { status: 503 });
        },
      },
    });

    const response = await handler(request);

    expect(response.status).toBe(499);
    expect(onErrorCalls).toBe(0);
  });

  test('a wrapped abort reason with an active request remains an application error', async () => {
    const transportReason = new Error('aborted');
    const wrapped = new Error('query cancelled', { cause: transportReason });
    let onErrorCalls = 0;
    const handler = createHandler({
      rawRoutes: [abortingRawRoute(wrapped)],
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return new Response('handled', { status: 503 });
        },
      },
    });

    const response = await handler(new Request('http://localhost/work'));

    expect(response.status).toBe(503);
    expect(onErrorCalls).toBe(1);
  });

  test('the abort-reason cause walk is inclusive at its documented depth limit', async () => {
    const transportReason = new Error('aborted');
    const wrap = (depth: number): unknown => {
      let error: unknown = transportReason;
      for (let link = 0; link < depth; link += 1) {
        error = new Error(`wrapper ${link}`, { cause: error });
      }
      return error;
    };

    // Eight links is the documented bound: the last link still resolves, the
    // ninth does not. Pinning both sides keeps an off-by-one in either
    // direction from passing as "bounded".
    for (const [depth, expected] of [
      [8, 499],
      [9, 503],
    ] as const) {
      const controller = new AbortController();
      const request = new Request('http://localhost/work', { signal: controller.signal });
      controller.abort(transportReason);
      const handler = createHandler({
        rawRoutes: [abortingRawRoute(wrap(depth))],
        hooks: { onError: () => new Response('handled', { status: 503 }) },
      });

      expect((await handler(request)).status).toBe(expected);
    }
  });

  test('unrelated cyclic and over-depth causes keep the ordinary error path', async () => {
    const transportReason = new Error('aborted');
    const unrelated = new Error('query failed', { cause: new Error('database failed') });
    const cyclic: { name: string; cause?: unknown } = { name: 'CyclicError' };
    cyclic.cause = cyclic;
    let overDepth: unknown = transportReason;
    for (let depth = 0; depth < 9; depth += 1) {
      overDepth = new Error(`wrapper ${depth}`, { cause: overDepth });
    }

    for (const error of [unrelated, cyclic, overDepth]) {
      const controller = new AbortController();
      const request = new Request('http://localhost/work', { signal: controller.signal });
      controller.abort(transportReason);
      let onErrorCalls = 0;
      const handler = createHandler({
        rawRoutes: [abortingRawRoute(error)],
        hooks: {
          onError: () => {
            onErrorCalls += 1;
            return new Response('handled', { status: 503 });
          },
        },
      });

      const response = await handler(request);

      expect(response.status).toBe(503);
      expect(onErrorCalls).toBe(1);
    }
  });

  test('a framework body-read AbortError is cancelled before the handler runs', async () => {
    const contract = defineContract(
      { prefix: 'uploads' },
      {
        create: {
          method: 'POST',
          path: '/',
          desc: 'Upload JSON',
          input: z.object({ name: z.string() }),
        },
      },
    );
    let handlerCalls = 0;
    const service = implement(contract, {
      create: () => {
        handlerCalls += 1;
      },
    });
    const controller = new AbortController();
    const error = new DOMException('The connection was closed', 'AbortError');
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.error(error);
      },
    });
    const request = new Request('http://localhost/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    controller.abort(error);
    let onErrorCalls = 0;
    const handler = createHandler({
      services: [service],
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return undefined;
        },
      },
    });

    const response = await handler(request);

    expect(response.status).toBe(499);
    expect(handlerCalls).toBe(0);
    expect(onErrorCalls).toBe(0);
  });

  test('a mid-stream abort interrupts a bounded body read without parsing partial JSON', async () => {
    const contract = defineContract(
      { prefix: 'uploads' },
      {
        create: {
          method: 'POST',
          path: '/',
          desc: 'Upload JSON',
          input: z.object({ name: z.string() }),
        },
      },
    );
    let handlerCalls = 0;
    let onErrorCalls = 0;
    const service = implement(contract, {
      create: () => {
        handlerCalls += 1;
      },
    });
    const controller = new AbortController();
    const error = new DOMException('The connection was closed', 'AbortError');
    const pullStarted = deferred();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"name":"partial'));
      },
      pull() {
        pullStarted.resolve();
        return new Promise<void>(() => undefined);
      },
    });
    const request = new Request('http://localhost/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const handler = createHandler({
      services: [service],
      maxJsonBodyBytes: 1_024,
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return undefined;
        },
      },
    });

    const responsePromise = handler(request);
    await withDeadline(pullStarted.promise, 'bounded body reader pull');
    controller.abort(error);
    const response = await withDeadline(responsePromise, 'bounded body abort response');

    expect(response.status).toBe(499);
    expect(await response.text()).toBe('');
    expect(handlerCalls).toBe(0);
    expect(onErrorCalls).toBe(0);
  });

  test('project-returned 499 is always an info access completion', async () => {
    const logs: LogRow[] = [];
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/closed',
          handler: () => new Response(null, { status: 499 }),
        },
      ],
      logging: { logger: recordingLogger(logs) },
    });

    const response = await handler(new Request('http://localhost/closed'));

    expect(response.status).toBe(499);
    expect(completionRows(logs)).toEqual([
      expect.objectContaining({
        level: 'info',
        fields: expect.objectContaining({ status: 499 }),
      }),
    ]);
  });

  test('opted-in cancellation rows use the ordinary filter, close and drop lifecycle', async () => {
    const written: RequestEvent[] = [];
    const dropped = deferred();
    const drops: RequestEvent[] = [];
    const observability = createObservability({
      request: {
        includeCancelled: true,
        filter: (event) => event.outcome === 'cancelled',
        write: (event) => void written.push(event),
        onDrop: ({ event }) => {
          drops.push(event);
          dropped.resolve();
        },
      },
    });
    observability.request?.complete({
      context: requestContext('/success'),
      statusCode: 200,
      durationMs: 1,
    });
    observability.request?.complete({
      context: requestContext('/cancelled'),
      statusCode: 499,
      durationMs: 2,
      outcome: 'cancelled',
    });
    const report = await observability.close();

    expect(written.map((event) => event.path)).toEqual(['/cancelled']);
    expect(report.request).toMatchObject({ filtered: 1, accepted: 1, completed: 1 });

    observability.request?.complete({
      context: requestContext('/after-close'),
      statusCode: 499,
      durationMs: 3,
      outcome: 'cancelled',
    });
    await withDeadline(dropped.promise, 'closed cancellation drop');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ path: '/after-close', outcome: 'cancelled' });
  });
});

describe('real Bun client disconnects', () => {
  test('a physical disconnect during an admitted handler completes as 499/info', async () => {
    const admitted = deferred();
    const aborted = deferred();
    const completed = deferred();
    const logs: LogRow[] = [];
    const events: RequestEvent[] = [];
    let onErrorCalls = 0;
    const observability = createObservability({
      request: { write: (event) => void events.push(event) },
    });
    const server = createServer({
      hostname: '127.0.0.1',
      port: 0,
      rawRoutes: [
        {
          method: 'GET',
          path: '/work',
          handler: (req) => {
            admitted.resolve();
            return waitForRequestAbort(req, aborted);
          },
        },
      ],
      logging: { logger: recordingLogger(logs, completed) },
      observability: observability.request,
      hooks: {
        onError: () => {
          onErrorCalls += 1;
          return undefined;
        },
      },
    });
    let socket: Socket | undefined;

    try {
      socket = await connectRaw(server.port);
      socket.write('GET /work HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      await withDeadline(admitted.promise, 'Bun handler admission');
      socket.destroy();
      await withDeadline(aborted.promise, 'Bun request signal abort');
      await withDeadline(completed.promise, 'Bun 499 completion');
      await observability.flush();

      expect(onErrorCalls).toBe(0);
      expect(events).toEqual([]);
      expect(completionRows(logs)).toEqual([
        expect.objectContaining({
          level: 'info',
          fields: expect.objectContaining({ status: 499 }),
        }),
      ]);
    } finally {
      socket?.destroy();
      await server.shutdown({ gracePeriodMs: 1_000 });
      await observability.close();
    }
  });

  test('a physical disconnect during partial JSON upload never reaches the handler', async () => {
    const admitted = deferred();
    const aborted = deferred();
    const release = deferred();
    const completed = deferred();
    const logs: LogRow[] = [];
    let handlerCalls = 0;
    let onErrorCalls = 0;
    const contract = defineContract(
      { prefix: 'uploads' },
      {
        create: {
          method: 'POST',
          path: '/',
          desc: 'Upload JSON',
          input: z.object({ name: z.string() }),
        },
      },
    );
    const service = implement(contract, {
      create: () => {
        handlerCalls += 1;
      },
    });
    const server = createServer({
      hostname: '127.0.0.1',
      port: 0,
      services: [service],
      logging: { logger: recordingLogger(logs, completed) },
      hooks: {
        onRequest: async (req) => {
          const markAborted = (): void => aborted.resolve();
          if (req.signal.aborted) markAborted();
          else req.signal.addEventListener('abort', markAborted, { once: true });
          admitted.resolve();
          await release.promise;
          return undefined;
        },
        onError: () => {
          onErrorCalls += 1;
          return undefined;
        },
      },
    });
    let socket: Socket | undefined;

    try {
      socket = await connectRaw(server.port);
      socket.write(
        'POST /uploads HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 100\r\n' +
          'Connection: close\r\n\r\n' +
          '{"name":"partial',
      );
      await withDeadline(admitted.promise, 'Bun upload admission');
      socket.destroy();
      await withDeadline(aborted.promise, 'Bun upload request signal abort');
      release.resolve();
      await withDeadline(completed.promise, 'Bun upload 499 completion');

      expect(handlerCalls).toBe(0);
      expect(onErrorCalls).toBe(0);
      expect(completionRows(logs)).toEqual([
        expect.objectContaining({
          level: 'info',
          fields: expect.objectContaining({ status: 499 }),
        }),
      ]);
    } finally {
      release.resolve();
      socket?.destroy();
      await server.shutdown({ gracePeriodMs: 1_000 });
    }
  });
});
