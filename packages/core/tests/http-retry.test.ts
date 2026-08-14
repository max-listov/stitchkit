import { expect, test } from 'bun:test';
import ky, { NetworkError, TimeoutError } from 'ky';
import { z } from 'zod';
import { ApiError, shouldRetryBunNetworkError } from '../src/browser/http';

const ProbeResultSchema = z.object({
  lateServer: z.object({
    attempts: z.number(),
    events: z.array(z.string()),
    result: z.object({ ok: z.boolean() }),
  }),
  exhausted: z.object({
    attempts: z.number(),
    events: z.array(z.string()),
    code: z.string(),
    status: z.number(),
  }),
  noRetry: z.object({
    attempts: z.number(),
    events: z.array(z.string()),
    code: z.string(),
    status: z.number(),
  }),
  post: z.object({ attempts: z.number(), code: z.string(), status: z.number() }),
  cancellation: z.object({
    alreadyAbortedCode: z.string(),
    attemptsAfterAlreadyAborted: z.number(),
    inFlightCode: z.string(),
    inFlightAttempts: z.number(),
    timeoutCode: z.string(),
    timeoutAttempts: z.number(),
    events: z.array(z.string()),
  }),
  responses: z.object({
    unauthorized: z.object({
      calls: z.number(),
      events: z.array(z.string()),
      error: z.object({ code: z.string(), status: z.number() }),
    }),
    status: z.object({ calls: z.number(), result: z.object({ ok: z.boolean() }) }),
  }),
});

test('Bun HTTP retry preserves method, budget, cancellation and response semantics', async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, 'tests/fixtures/http-retry-probe.ts'],
    cwd: import.meta.dir.replace(/\/tests$/, ''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  expect(exitCode, stderr).toBe(0);
  const result = ProbeResultSchema.parse(JSON.parse(stdout));

  expect(result.lateServer).toEqual({ attempts: 2, events: [], result: { ok: true } });
  expect(result.exhausted).toEqual({
    attempts: 3,
    events: ['network_error'],
    code: 'UNKNOWN_ERROR',
    status: 0,
  });
  expect(result.noRetry).toEqual({
    attempts: 1,
    events: ['network_error'],
    code: 'UNKNOWN_ERROR',
    status: 0,
  });
  expect(result.post).toEqual({ attempts: 1, code: 'UNKNOWN_ERROR', status: 0 });
  expect(result.cancellation).toEqual({
    alreadyAbortedCode: 'REQUEST_ABORTED',
    attemptsAfterAlreadyAborted: 0,
    inFlightCode: 'REQUEST_ABORTED',
    inFlightAttempts: 1,
    timeoutCode: 'REQUEST_TIMEOUT',
    timeoutAttempts: 1,
    events: [],
  });
  expect(result.responses).toEqual({
    unauthorized: {
      calls: 1,
      events: ['unauthorized'],
      error: { code: 'ConnectionRefused', status: 401 },
    },
    status: { calls: 2, result: { ok: true } },
  });
});

test('Bun classifier is exact, own-property-only and leaves Ky semantics untouched', async () => {
  const connectionRefused = new Error('Bun fetch failed');
  Object.defineProperty(connectionRefused, 'code', { value: 'ConnectionRefused' });
  expect(shouldRetryBunNetworkError(connectionRefused)).toBe(true);

  const unknown = new Error('unknown runtime error');
  Object.defineProperty(unknown, 'code', { value: 'ConnectionReset' });
  expect(shouldRetryBunNetworkError(unknown)).toBeUndefined();

  const inherited = Object.create(connectionRefused);
  expect(shouldRetryBunNetworkError(inherited)).toBeUndefined();

  let accessorRead = false;
  const accessor = new Error('accessor');
  Object.defineProperty(accessor, 'code', {
    get() {
      accessorRead = true;
      return 'ConnectionRefused';
    },
  });
  expect(shouldRetryBunNetworkError(accessor)).toBeUndefined();
  expect(accessorRead).toBe(false);

  expect(shouldRetryBunNetworkError(new ApiError('ConnectionRefused', 401))).toBeUndefined();
  expect(
    shouldRetryBunNetworkError(new NetworkError(new Request('http://localhost'))),
  ).toBeUndefined();
  expect(
    shouldRetryBunNetworkError(new TimeoutError(new Request('http://localhost'))),
  ).toBeUndefined();
  expect(
    shouldRetryBunNetworkError(new DOMException('cancelled', 'AbortError')),
  ).toBeUndefined();

  const server = Bun.serve({ port: 0, fetch: () => new Response('down', { status: 503 }) });
  try {
    let httpError: unknown;
    try {
      await ky.get(`http://127.0.0.1:${server.port}`, { retry: 0 });
    } catch (error) {
      httpError = error;
    }
    expect(shouldRetryBunNetworkError(httpError)).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});
