import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../src/browser/api-error';
import { createClient } from '../src/browser/client';
import { createServer, implement } from '../src/entrypoints/server';
import { createOperationProcesses } from '../src/process/operation';
import { runOperationProcess } from '../src/process/operation-child';
import { heavyContract } from './fixtures/operation-process-contract';
import { reapAfterEachTest, trackPidFile } from './support/process-reaper';

reapAfterEachTest();

const CHILD = join(import.meta.dir, 'fixtures/operation-process-child.ts');

function start(limits: {
  maxConcurrent?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}) {
  const processes = createOperationProcesses({
    command: { executable: process.execPath, args: [CHILD], envPolicy: 'ambient' },
    maxConcurrent: limits.maxConcurrent ?? 2,
    maxResponseBytes: limits.maxResponseBytes ?? 64 * 1024,
    timeoutMs: limits.timeoutMs ?? 20_000,
  });
  const service = implement(heavyContract, {
    search: processes.unary(heavyContract, 'search'),
    ping: () => ({ ok: true }),
    follow: processes.stream(heavyContract, 'follow'),
    linger: processes.stream(heavyContract, 'linger'),
  });
  const server = createServer({ port: 0, logging: false, services: [service] });
  const client = createClient(heavyContract, { baseUrl: server.url, timeout: 30_000 });
  return { processes, service, client, stop: () => void server.runtime?.stop(true) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function refusal(call: Promise<unknown>): Promise<ApiError> {
  const error = await call.catch((caught: unknown) => caught);
  if (!(error instanceof ApiError))
    throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe('an operation executed in a process of its own', () => {
  test('answers through the contract, and a bad input never starts a process', async () => {
    const { client, processes, stop } = start({});
    try {
      expect(await client.search({ query: 'needle' })).toEqual({
        matches: ['found:needle:0'],
      });
      expect((await refusal(client.search({ query: '' }))).code).toBe('VALIDATION_ERROR');
      expect(processes.active).toBe(0);
    } finally {
      stop();
    }
  }, 30_000);

  test('a cheap operation answers in its own time while a heavy one runs', async () => {
    const { client, stop } = start({});
    try {
      // Warm the route so the measurement is the loop, not the first request.
      await client.ping();
      const heavyStartedAt = performance.now();
      const heavy = client.search({ query: 'needle', busyMs: 1_500 });
      await Bun.sleep(300);
      const pings: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const startedAt = performance.now();
        expect(await client.ping()).toEqual({ ok: true });
        pings.push(performance.now() - startedAt);
      }
      const pingsDoneAfterMs = performance.now() - heavyStartedAt;
      await heavy;
      const heavyMs = performance.now() - heavyStartedAt;
      // The heavy call really held a process for its whole scan…
      expect(heavyMs).toBeGreaterThan(1_500);
      // …and every cheap call finished inside it, each far below the scan.
      expect(pingsDoneAfterMs).toBeLessThan(heavyMs);
      expect(Math.max(...pings)).toBeLessThan(250);
    } finally {
      stop();
    }
  }, 30_000);

  test('a caller that leaves ends the process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sk-operation-'));
    const pidFile = join(directory, 'pid');
    trackPidFile(pidFile);
    const { client, processes, stop } = start({});
    try {
      const controller = new AbortController();
      const call = client.search.withOptions(
        { query: 'needle', mode: 'hang', pidFile },
        { signal: controller.signal },
      );
      let pid = 0;
      for (let attempt = 0; attempt < 100 && pid === 0; attempt += 1) {
        await Bun.sleep(50);
        pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      }
      expect(pid).toBeGreaterThan(0);
      // The control: the process is there before the caller leaves.
      expect(alive(pid)).toBe(true);
      controller.abort();
      await expect(call).rejects.toThrow();
      for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) await Bun.sleep(50);
      expect(alive(pid)).toBe(false);
      for (let attempt = 0; attempt < 100 && processes.active > 0; attempt += 1) {
        await Bun.sleep(20);
      }
      expect(processes.active).toBe(0);
    } finally {
      stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test('the deadline ends the process with REQUEST_TIMEOUT', async () => {
    const { client, stop } = start({ timeoutMs: 400 });
    try {
      const error = await refusal(client.search({ query: 'needle', mode: 'hang' }));
      expect(error.code).toBe('REQUEST_TIMEOUT');
    } finally {
      stop();
    }
  }, 30_000);

  test('an answer over the bound and a call over the limit are two different refusals', async () => {
    const { client, stop } = start({ maxConcurrent: 1 });
    try {
      const big = await refusal(client.search({ query: 'needle', mode: 'big' }));
      expect(big.code).toBe('OPERATION_RESPONSE_TOO_LARGE');
      expect(big.details).toMatchObject({
        operation: 'heavy.search',
        maxResponseBytes: 65_536,
      });

      const first = client.search({ query: 'needle', busyMs: 800 });
      await Bun.sleep(200);
      const busy = await refusal(client.search({ query: 'second' }));
      expect(busy.code).toBe('OPERATION_BUSY');
      expect(busy.status).toBe(503);
      expect(busy.retryable).toBe(true);
      // Refused, not queued: the first call is still the only one, and it completes.
      expect(await first).toEqual({ matches: ['found:needle:0'] });
      expect(await client.search({ query: 'third' })).toEqual({ matches: ['found:third:0'] });
    } finally {
      stop();
    }
  }, 30_000);

  test('a stream delivers items as the process produces them', async () => {
    const { client, processes, stop } = start({});
    try {
      const arrivals: number[] = [];
      const startedAt = performance.now();
      const items: unknown[] = [];
      for await (const item of await client.follow({ count: 3, gapMs: 300 })) {
        items.push(item);
        arrivals.push(performance.now() - startedAt);
      }
      expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      // The first item arrived well before the last was produced.
      expect((arrivals[2] ?? 0) - (arrivals[0] ?? 0)).toBeGreaterThan(400);
      for (let attempt = 0; attempt < 100 && processes.active > 0; attempt += 1) {
        await Bun.sleep(20);
      }
      expect(processes.active).toBe(0);
    } finally {
      stop();
    }
  }, 30_000);

  test('a refusal the child throws arrives as that refusal, unary and streamed', async () => {
    const { client, stop } = start({});
    try {
      const unary = await refusal(client.search({ query: 'needle', mode: 'refuse' }));
      expect(unary.code).toBe('RECORD_LOCKED');
      expect(unary.status).toBe(423);
      expect(unary.details).toEqual({ record: 'r-1' });
      expect(unary.retryable).toBe(true);

      const stream = await client.follow({ count: 3, mode: 'refuse' });
      expect(await stream.next()).toEqual({ done: false, value: { n: 1 } });
      const streamed = await stream.next().catch((caught: unknown) => caught);
      expect(streamed).toMatchObject({ code: 'RECORD_LOCKED', details: { record: 'r-1' } });
    } finally {
      stop();
    }
  }, 30_000);

  test('a child that dies is OPERATION_PROCESS_FAILED, its stderr only in the cause', async () => {
    const { processes, stop } = start({});
    try {
      const handler = processes.unary(heavyContract, 'search');
      const error = await handler({ input: { query: 'needle', mode: 'crash' } }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'OPERATION_PROCESS_FAILED', status: 500 });
      expect(JSON.stringify(error)).not.toContain('exit 3');
      expect(String(Reflect.get(Object(error), 'cause'))).toContain('exit 3');
      expect(processes.active).toBe(0);
    } finally {
      stop();
    }
  }, 30_000);

  test('stderr does not spend the answer budget, and a large call is delivered whole', async () => {
    const { processes, stop } = start({ maxResponseBytes: 4_096 });
    try {
      const handler = processes.unary(heavyContract, 'search');
      // 320 KB of stderr against a 4 KB answer bound.
      expect(await handler({ input: { query: 'needle', mode: 'noisy' } })).toEqual({
        matches: ['found:needle:0'],
      });
      // A call of 2 MiB, twice the command primitive's default stdin bound.
      const padding = 'p'.repeat(2 * 1024 * 1024);
      expect(await handler({ input: { query: 'needle', padding } })).toEqual({
        matches: [`found:needle:${padding.length}`],
      });
    } finally {
      stop();
    }
  }, 30_000);

  test('a stream that cannot start gives its slot back', async () => {
    const { processes, stop } = start({ maxConcurrent: 1 });
    try {
      const stream = processes.stream(heavyContract, 'follow');
      const aborted = AbortSignal.abort();
      const read = async (): Promise<unknown> => {
        for await (const item of stream({ input: { count: 1 }, signal: aborted })) return item;
        return undefined;
      };
      await expect(read()).rejects.toThrow();
      expect(processes.active).toBe(0);
      // The control: the single slot still serves the next call.
      const items: unknown[] = [];
      for await (const item of stream({ input: { count: 2 } })) items.push(item);
      expect(items).toEqual([{ n: 1 }, { n: 2 }]);
      expect(processes.active).toBe(0);
    } finally {
      stop();
    }
  }, 30_000);

  test('one stream item over the bound is OPERATION_RESPONSE_TOO_LARGE', async () => {
    const { processes, stop } = start({});
    try {
      const stream = processes.stream(heavyContract, 'follow');
      const items: unknown[] = [];
      const read = async (): Promise<void> => {
        for await (const item of stream({ input: { count: 3, mode: 'big' } }))
          items.push(item);
      };
      await expect(read()).rejects.toMatchObject({ code: 'OPERATION_RESPONSE_TOO_LARGE' });
      expect(items).toEqual([{ n: 1 }]);
      expect(processes.active).toBe(0);
    } finally {
      stop();
    }
  }, 30_000);

  test('the contract lifetime of a stream ends its process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sk-operation-'));
    const pidFile = join(directory, 'pid');
    trackPidFile(pidFile);
    const { client, processes, stop } = start({});
    try {
      const items: unknown[] = [];
      const read = async (): Promise<void> => {
        for await (const item of await client.linger({ pidFile })) items.push(item);
      };
      await expect(read()).rejects.toMatchObject({ code: 'STREAM_LIFETIME_EXCEEDED' });
      expect(items.length).toBeGreaterThan(0);
      const pid = Number(await readFile(pidFile, 'utf8'));
      for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) await Bun.sleep(50);
      expect(alive(pid)).toBe(false);
      for (let attempt = 0; attempt < 100 && processes.active > 0; attempt += 1) {
        await Bun.sleep(20);
      }
      expect(processes.active).toBe(0);
    } finally {
      stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test('the child reads its call, writes its answer and stops through injected io', async () => {
    const service = implement(heavyContract, {
      search: ({ input }) => ({ matches: [`in-process:${input.query}`] }),
      ping: () => ({ ok: true }),
      follow: ({ signal }) =>
        (async function* () {
          for (let n = 1; ; n += 1) {
            if (signal?.aborted) return;
            yield { n };
            await Bun.sleep(10);
          }
        })(),
      linger: () =>
        (async function* () {
          yield { n: 0 };
        })(),
    });
    const written: string[] = [];
    const write = async (text: string): Promise<void> => {
      written.push(text);
    };
    const call = (value: unknown) => async (): Promise<string> => JSON.stringify(value);
    expect(
      await runOperationProcess([service], {
        readCall: call({ operation: 'heavy.search', kind: 'unary', input: { query: 'q' } }),
        write,
        signal: new AbortController().signal,
      }),
    ).toBe(0);
    expect(JSON.parse(written[0] ?? '')).toEqual({
      ok: true,
      data: { matches: ['in-process:q'] },
    });

    written.length = 0;
    await runOperationProcess([service], {
      readCall: call({ operation: 'heavy.absent', kind: 'unary' }),
      write,
      signal: new AbortController().signal,
    });
    expect(JSON.parse(written[0] ?? '')).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_OPERATION', status: 404 },
    });

    // The stop signal ends an endless stream without an end frame of its own.
    written.length = 0;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    await runOperationProcess([service], {
      readCall: call({ operation: 'heavy.follow', kind: 'stream', input: { count: 1 } }),
      write,
      signal: stop.signal,
    });
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((line) => JSON.parse(line).type === 'data')).toBe(true);
  }, 30_000);
});
