import { ApiError, createHttpClient } from '../../src/browser/http';

type Probe = {
  attempts(): number;
  firstAttempt: Promise<void>;
  firstFailure: Promise<unknown>;
  restore(): void;
};

function installFetchProbe(): Probe {
  const nativeFetch = globalThis.fetch;
  let attempts = 0;
  let resolveFirstAttempt = (): void => undefined;
  let resolveFirstFailure = (_error: unknown): void => undefined;
  const firstAttempt = new Promise<void>((resolve) => {
    resolveFirstAttempt = resolve;
  });
  const firstFailure = new Promise<unknown>((resolve) => {
    resolveFirstFailure = resolve;
  });

  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      attempts += 1;
      if (attempts === 1) resolveFirstAttempt();
      try {
        return await nativeFetch(input, init);
      } catch (error) {
        if (attempts === 1) resolveFirstFailure(error);
        throw error;
      }
    },
    { preconnect: nativeFetch.preconnect },
  );

  return {
    attempts: () => attempts,
    firstAttempt,
    firstFailure,
    restore() {
      globalThis.fetch = nativeFetch;
    },
  };
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its test deadline`)), 5_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function reserveClosedPort(): Promise<number> {
  const reservation = Bun.serve({
    port: 0,
    fetch: () => new Response('reserved'),
  });
  const port = reservation.port;
  if (port === undefined) throw new Error('Bun did not assign a reservation port');
  await reservation.stop(true);
  return port;
}

function ownCode(error: unknown): unknown {
  if (!(error instanceof Error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

async function lateServerProbe() {
  const port = await reserveClosedPort();
  const probe = installFetchProbe();
  const events: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const http = createHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    http.subscribe((event) => void events.push(event.type));
    const pending = http.get<{ ok: boolean }>('/probe');
    void pending.catch(() => undefined);
    const firstError = await withDeadline(probe.firstFailure, 'first connection failure');
    if (ownCode(firstError) !== 'ConnectionRefused') {
      throw new Error(
        `Expected Bun ConnectionRefused, received ${String(ownCode(firstError))}`,
      );
    }
    server = Bun.serve({ port, fetch: () => Response.json({ ok: true }) });
    const result = await withDeadline(pending, 'late-server retry');
    return { attempts: probe.attempts(), events, result };
  } finally {
    probe.restore();
    await server?.stop(true);
  }
}

async function exhaustedProbe(limit: number) {
  const port = await reserveClosedPort();
  const probe = installFetchProbe();
  const events: string[] = [];
  try {
    const http = createHttpClient({
      baseUrl: `http://127.0.0.1:${port}`,
      retry: { limit },
    });
    http.subscribe((event) => void events.push(event.type));
    try {
      await withDeadline(http.get('/probe'), `exhausted limit ${limit}`);
      throw new Error('Expected the closed-port request to fail');
    } catch (error) {
      if (!ApiError.is(error)) throw error;
      return {
        attempts: probe.attempts(),
        events,
        code: error.code,
        status: error.status,
      };
    }
  } finally {
    probe.restore();
  }
}

async function postProbe() {
  const port = await reserveClosedPort();
  const probe = installFetchProbe();
  try {
    const http = createHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      await withDeadline(http.post('/probe', { value: true }), 'POST method gate');
      throw new Error('Expected the closed-port POST to fail');
    } catch (error) {
      if (!ApiError.is(error)) throw error;
      return { attempts: probe.attempts(), code: error.code, status: error.status };
    }
  } finally {
    probe.restore();
  }
}

async function cancellationProbe() {
  const probe = installFetchProbe();
  const events: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const unusedPort = await reserveClosedPort();
    const abortedHttp = createHttpClient({ baseUrl: `http://127.0.0.1:${unusedPort}` });
    abortedHttp.subscribe((event) => void events.push(event.type));
    let alreadyAbortedCode = '';
    try {
      await abortedHttp.get('/probe', { signal: alreadyAborted.signal });
    } catch (error) {
      if (!ApiError.is(error)) throw error;
      alreadyAbortedCode = error.code;
    }
    const attemptsAfterAlreadyAborted = probe.attempts();

    server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(250);
        return Response.json({ ok: true });
      },
    });
    const http = createHttpClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    http.subscribe((event) => void events.push(event.type));

    const controller = new AbortController();
    const inFlight = http.get('/abort', { signal: controller.signal });
    void inFlight.catch(() => undefined);
    await withDeadline(probe.firstAttempt, 'in-flight request start');
    controller.abort();
    let inFlightCode = '';
    try {
      await inFlight;
    } catch (error) {
      if (!ApiError.is(error)) throw error;
      inFlightCode = error.code;
    }
    const attemptsAfterInFlight = probe.attempts();

    let timeoutCode = '';
    try {
      await http.get('/timeout', { timeout: 5 });
    } catch (error) {
      if (!ApiError.is(error)) throw error;
      timeoutCode = error.code;
    }

    return {
      alreadyAbortedCode,
      attemptsAfterAlreadyAborted,
      inFlightCode,
      inFlightAttempts: attemptsAfterInFlight - attemptsAfterAlreadyAborted,
      timeoutCode,
      timeoutAttempts: probe.attempts() - attemptsAfterInFlight,
      events,
    };
  } finally {
    probe.restore();
    await server?.stop(true);
  }
}

async function responseSemanticsProbe() {
  let unauthorizedCalls = 0;
  let statusCalls = 0;
  const unauthorizedServer = Bun.serve({
    port: 0,
    fetch() {
      unauthorizedCalls += 1;
      return Response.json(
        { error: { code: 'ConnectionRefused', message: 'Authentication required' } },
        { status: 401 },
      );
    },
  });
  const statusServer = Bun.serve({
    port: 0,
    fetch() {
      statusCalls += 1;
      return statusCalls === 1
        ? new Response('temporarily unavailable', { status: 503 })
        : Response.json({ ok: true });
    },
  });
  try {
    const unauthorizedEvents: string[] = [];
    const unauthorizedHttp = createHttpClient({
      baseUrl: `http://127.0.0.1:${unauthorizedServer.port}`,
    });
    unauthorizedHttp.subscribe((event) => void unauthorizedEvents.push(event.type));
    let unauthorizedError = { code: '', status: 0 };
    try {
      await unauthorizedHttp.get('/probe');
    } catch (error) {
      if (!ApiError.is(error)) throw error;
      unauthorizedError = { code: error.code, status: error.status };
    }

    const statusHttp = createHttpClient({
      baseUrl: `http://127.0.0.1:${statusServer.port}`,
      retry: { limit: 1, statusCodes: [503] },
    });
    const statusResult = await withDeadline(
      statusHttp.get<{ ok: boolean }>('/probe'),
      'configured 503 retry',
    );
    return {
      unauthorized: {
        calls: unauthorizedCalls,
        events: unauthorizedEvents,
        error: unauthorizedError,
      },
      status: { calls: statusCalls, result: statusResult },
    };
  } finally {
    await unauthorizedServer.stop(true);
    await statusServer.stop(true);
  }
}

const result = {
  lateServer: await lateServerProbe(),
  exhausted: await exhaustedProbe(2),
  noRetry: await exhaustedProbe(0),
  post: await postProbe(),
  cancellation: await cancellationProbe(),
  responses: await responseSemanticsProbe(),
};

process.stdout.write(JSON.stringify(result));
