/**
 * The options that reached a timer with no check at all. Each is refused by the one timer rule
 * (`assertTimerMs`, or a schema stating `MAX_TIMER_MS` where the option is a parsed field) where it
 * is taken, before the component schedules, sends or starts anything. 2 ** 31 ms is one past
 * `MAX_TIMER_MS`: a timer of it fires at once.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BackoffPolicySchema,
  createClient,
  createHttpClient,
  createSocketIOClient,
  uploadInChunks,
} from '../src/entrypoints';
import { createExecutorLeases, ThreadLeaseSchema } from '../src/entrypoints/agent-executor';
import { createAgentSessionCoordinator } from '../src/entrypoints/agent-runtime';
import { defineAgentFaultPlan } from '../src/entrypoints/agent-runtime/testing';
import {
  createApplication,
  createCreditWindow,
  createManagedSchedule,
  createNotificationOutbox,
  createWatchHub,
} from '../src/entrypoints/application';
import { defineContract } from '../src/entrypoints/contract';
import { createManagedFileBoundary } from '../src/entrypoints/files';
import { createGeoIpResolver } from '../src/entrypoints/geo';
import { createWatchClient, type WatchTransport } from '../src/entrypoints/live';
import { createCacheBridge } from '../src/entrypoints/react';
import { createReleaseWatcher } from '../src/entrypoints/release';
import { createUnixClientTransport } from '../src/entrypoints/server';
import {
  createTelegramUpdateIntake,
  memoryTelegramUpdateStore,
} from '../src/entrypoints/telegram';
import { defineWaitTool, mountWait } from '../src/entrypoints/tools';
import { createTrackingClient, deliverTrackingBatch } from '../src/entrypoints/tracking';
import { createPerformanceCollector } from '../src/entrypoints/tracking/performance';
import { MAX_TIMER_MS } from '../src/internal/timers';
import { pollUntil } from '../src/tools/operations/wait-core';
import { expectTimerRefusal, expectTimerRejection } from './support/timer-refusal';

const PAST = 2 ** 31;

function watchTransport(): { transport: WatchTransport; requests: () => number } {
  let requests = 0;
  return {
    transport: {
      on: () => () => undefined,
      emit: () => undefined,
      request: () => {
        requests += 1;
        return new Promise(() => undefined);
      },
      onConnectionChange: () => () => undefined,
    },
    requests: () => requests,
  };
}

describe('an option that reached a timer unchecked is refused where it is taken', () => {
  test('stitchkit: a retry policy states the timer ceiling', () => {
    expect(
      BackoffPolicySchema.safeParse({ minDelayMs: 1, maxDelayMs: PAST, jitter: 0 }).success,
    ).toBe(false);
    expect(
      BackoffPolicySchema.safeParse({ minDelayMs: PAST, maxDelayMs: PAST, jitter: 0 }).success,
    ).toBe(false);
    expect(
      BackoffPolicySchema.safeParse({ minDelayMs: 1, maxDelayMs: MAX_TIMER_MS, jitter: 0 })
        .success,
    ).toBe(true);
  });

  test('stitchkit: the HTTP client timeout, at the factory and before a request is sent', async () => {
    expectTimerRefusal(
      () => createHttpClient({ baseUrl: 'http://127.0.0.1:9', timeout: PAST }),
      'HTTP client timeout',
      PAST,
    );
    let sent = 0;
    const client = createHttpClient({
      baseUrl: 'http://127.0.0.1:9',
      fetch: () => {
        sent += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    await expectTimerRejection(
      client.get('/x', { timeout: PAST }),
      'HTTP request timeout',
      PAST,
    );
    expect(sent).toBe(0);
    const contract = defineContract(
      { prefix: 'ping' },
      { ping: { method: 'GET', path: '/ping', desc: 'Ping', output: z.object({}) } },
    );
    expectTimerRefusal(
      () => createClient(contract, { baseUrl: 'http://127.0.0.1:9', timeout: PAST }),
      'HTTP client timeout',
      PAST,
    );
  });

  test('stitchkit/contract: an endpoint client timeout', () => {
    expectTimerRefusal(
      () =>
        defineContract(
          { prefix: 'slow' },
          {
            run: {
              method: 'POST',
              path: '/run',
              desc: 'A slow call',
              input: z.object({}),
              output: z.object({}),
              timeout: PAST,
            },
          },
        ),
      'Contract "slow": endpoint "run" timeout',
      PAST,
    );
  });

  test('stitchkit: a chunked upload retry pause, before a part is sent', async () => {
    let sent = 0;
    await expectTimerRejection(
      uploadInChunks({
        file: new Blob(['abc']),
        chunkBytes: 1,
        retryDelayMs: PAST,
        init: () => {
          sent += 1;
          return Promise.resolve({ uploadId: 'u' });
        },
        part: () => {
          sent += 1;
          return Promise.resolve();
        },
        complete: () => Promise.resolve('done'),
      } as never),
      'uploadInChunks retryDelayMs',
      PAST,
      0,
    );
    expect(sent).toBe(0);
  });

  test('stitchkit: a chunked upload retry pause doubles up to the timer ceiling, not past it', async () => {
    // 2 ** 30 doubled is 2 ** 31, one past the ceiling: a timer of it fired at once.
    const pauses: number[] = [];
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number,
    ) => {
      pauses.push(ms ?? 0);
      queueMicrotask(callback);
      return 0;
    }) as never);
    try {
      const failure = await uploadInChunks({
        file: new Blob(['abc']),
        chunkBytes: 3,
        retries: 3,
        retryDelayMs: 2 ** 30,
        init: async () => undefined,
        chunk: () => Promise.reject(new TypeError('network down')),
        finalize: async () => 'never',
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
    } finally {
      timer.mockRestore();
    }
    expect(pauses).toEqual([2 ** 30, MAX_TIMER_MS, MAX_TIMER_MS]);
  });

  test('stitchkit: the server-disconnect recycle delay', () => {
    expectTimerRefusal(
      () =>
        createSocketIOClient({ url: 'http://127.0.0.1:9', reconnectOnServerDisconnect: PAST }),
      'reconnectOnServerDisconnect',
      PAST,
      0,
    );
  });

  test('stitchkit/react: the cache bridge fresh window', () => {
    expectTimerRefusal(
      () =>
        createCacheBridge({
          socket: { on: () => undefined, off: () => undefined } as never,
          queryClient: new QueryClient(),
          handlers: {},
          freshWindow: PAST,
        }),
      'cacheBridge.freshWindow',
      PAST,
      0,
    );
  });

  test('stitchkit/live: a watch client hold and open deadline, before a watch opens', () => {
    const contract = defineContract({ prefix: 'notes' }, {});
    for (const option of ['holdMs', 'openTimeoutMs'] as const) {
      const fake = watchTransport();
      expectTimerRefusal(
        () => createWatchClient(contract, { transport: fake.transport, [option]: PAST }),
        `Watch client ${option}`,
        PAST,
        option === 'holdMs' ? 0 : 1,
      );
      expect(fake.requests()).toBe(0);
    }
  });

  test('stitchkit/application: a watch hub hold and its retry policy', () => {
    const hub = {
      read: async () => ({}),
      watchable: () => true,
      invalidatedBy: () => [],
      subscribe: () => () => undefined,
    };
    expectTimerRefusal(
      () => createWatchHub({ ...hub, holdMs: PAST }),
      'Watch hub holdMs',
      PAST,
      0,
    );
    expect(() =>
      createWatchHub({ ...hub, backoff: { minDelayMs: 1, maxDelayMs: PAST, jitter: 0 } }),
    ).toThrow(z.ZodError);
  });

  test('stitchkit/application: an outbox poll interval, by its schema', () => {
    expect(() =>
      createNotificationOutbox({
        store: {} as never,
        payloadSchema: z.object({}),
        send: () => undefined,
        classify: () => 'retry' as never,
        pollIntervalMs: PAST,
      }),
    ).toThrow(z.ZodError);
  });

  test('stitchkit/application: a credit window wait', async () => {
    const window = createCreditWindow({ capacityBytes: 10 });
    await expectTimerRejection(
      Promise.resolve().then(() => window.acquire(1, { timeoutMs: PAST })),
      'Credit window wait timeoutMs',
      PAST,
    );
    expect(window.getSnapshot().leasedBytes).toBe(0);
  });

  test('stitchkit/application: a schedule period past the ceiling waits in steps of it', () => {
    const delays: number[] = [];
    const due: Array<() => void> = [];
    let now = 0;
    const runs: number[] = [];
    const schedule = createManagedSchedule({
      id: 'monthly',
      everyMs: PAST + 1_000,
      clock: {
        now: () => now,
        wallNow: () => new Date(0),
        schedule(callback, delayMs) {
          delays.push(delayMs);
          due.push(callback);
          return { cancel: () => undefined };
        },
      },
      run: ({ scheduledAt }) => {
        runs.push(scheduledAt);
      },
    });
    const context = {
      applicationId: 'steps',
      admission: {
        acquire: () => null,
        acquireWhenAccepting: () => new Promise(() => undefined),
      },
      signal: new AbortController().signal,
      now: () => now,
      reportHealth: () => undefined,
      use: () => {
        throw new Error('no graph');
      },
    } as never;
    schedule.start(context);
    schedule.activate?.(context);
    expect(delays).toEqual([MAX_TIMER_MS]);
    now = MAX_TIMER_MS;
    due.shift()?.();
    // The first step ends short of the period: nothing ran, the rest is armed.
    expect(runs).toEqual([]);
    expect(delays).toEqual([MAX_TIMER_MS, PAST + 1_000 - MAX_TIMER_MS]);
  });

  describe('stitchkit/application: a kernel force deadline is grace plus force, waited for in steps', () => {
    // Each budget is the largest a timer holds, so their sum is past it: a single timer of it fired
    // at once and aborted the close or force a resource was still in.
    const budget = { gracePeriodMs: MAX_TIMER_MS, forceTimeoutMs: MAX_TIMER_MS };
    /** A close that takes a moment and reports whether its signal was aborted by then. */
    const slowClose = (seen: boolean[]) => async (context: { signal: AbortSignal }) => {
      await Bun.sleep(20);
      seen.push(context.signal.aborted);
    };

    test('a startup rollback', async () => {
      const seen: boolean[] = [];
      const app = createApplication({
        id: 'rollback-steps',
        shutdown: budget,
        resources: [
          { id: 'first', start: () => undefined, close: slowClose(seen) },
          {
            id: 'failing',
            start: () => {
              throw new Error('start failed');
            },
          },
        ],
      });
      await expect(app.start()).rejects.toThrow('start failed');
      expect(seen).toEqual([false]);
    });

    test('a restart', async () => {
      const seen: boolean[] = [];
      const app = createApplication({
        id: 'restart-steps',
        resources: [{ id: 'cache', start: () => undefined, close: slowClose(seen) }],
      });
      await app.start();
      await app.restart({ resourceId: 'cache', ...budget });
      expect(seen).toEqual([false]);
      await app.shutdown({ gracePeriodMs: 0, forceTimeoutMs: 1_000 });
    });

    test('a shutdown forced by its signal', async () => {
      const seen: boolean[] = [];
      const app = createApplication({
        id: 'force-steps',
        resources: [
          {
            id: 'stuck',
            start: () => undefined,
            close: () => new Promise<void>(() => undefined),
            force: slowClose(seen),
          },
        ],
      });
      await app.start();
      const forced = new AbortController();
      forced.abort();
      await app.shutdown({ ...budget, signal: forced.signal });
      expect(seen).toEqual([false]);
    });
  });

  test('stitchkit/tools: a wait timeout in seconds, at definition and before the first poll', async () => {
    // 2147483.648 s is one millisecond past the ceiling; 0 is a deadline already due.
    const past = MAX_TIMER_MS / 1000 + 0.001;
    const refusal = (name: string, value: number) =>
      new RangeError(
        `${name} must be a number of seconds from 0 to ${MAX_TIMER_MS / 1000}, received ${value}`,
      );
    const expectSecondsRefusal = (run: () => unknown, name: string, value: number) => {
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect(thrown).toMatchObject({ message: refusal(name, value).message });
    };
    expectSecondsRefusal(
      () =>
        defineWaitTool({
          description: 'Wait for a job',
          identity: { serviceName: 'jobs', action: 'wait' },
          input: z.object({ id: z.string() }),
          state: z.object({ done: z.boolean() }),
          poll: () => ({ done: true }),
          done: (state) => state.done,
          defaultTimeout: past,
        }),
      'defineWaitTool defaultTimeout',
      past,
    );
    expectSecondsRefusal(
      () =>
        mountWait(new McpServer({ name: 'wait-rule', version: '1' }), {
          description: 'Wait',
          inputSchema: { id: z.string() },
          poll: async () => ({}),
          done: () => true,
          defaultTimeout: past,
        }),
      'mountWait defaultTimeout',
      past,
    );
    for (const value of [past, -1, Number.NaN]) {
      let polled = 0;
      const thrown = await pollUntil({
        poll: async () => ++polled,
        done: () => true,
        timeoutSec: value,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(RangeError);
      expect(thrown).toMatchObject({ message: refusal('timeoutSec', value).message });
      expect(polled).toBe(0);
    }
    expect(
      (
        await pollUntil({
          poll: async () => 1,
          done: () => true,
          timeoutSec: MAX_TIMER_MS / 1000,
        })
      ).timedOut,
    ).toBe(false);
  });

  test('stitchkit/telegram: the update intake lease and sweep', () => {
    for (const option of ['leaseMs', 'sweepEveryMs'] as const) {
      expectTimerRefusal(
        () =>
          createTelegramUpdateIntake({
            store: memoryTelegramUpdateStore(),
            handle: () => undefined,
            [option]: PAST,
          }),
        `[stitchkit] telegram update intake: ${option}`,
        PAST,
      );
    }
  });

  test('stitchkit/agent-runtime: a session close grace and force budget', async () => {
    for (const option of ['gracePeriodMs', 'forceTimeoutMs'] as const) {
      await expectTimerRejection(
        createAgentSessionCoordinator().close({ [option]: PAST }),
        `Agent session close ${option}`,
        PAST,
        0,
      );
    }
  });

  test('stitchkit/agent-executor: a lease TTL, granted and read off the wire', () => {
    expectTimerRefusal(
      () => createExecutorLeases({ store: {} as never, now: () => 0, ttlMs: PAST }),
      'ttlMs',
      PAST,
    );
    expect(ThreadLeaseSchema.safeParse({ threadId: 't', fence: 1, ttlMs: PAST }).success).toBe(
      false,
    );
    expect(
      ThreadLeaseSchema.safeParse({ threadId: 't', fence: 1, ttlMs: MAX_TIMER_MS }).success,
    ).toBe(true);
  });

  test('stitchkit/agent-runtime/testing: a scripted wait before the first byte, by its schema', () => {
    expect(() =>
      defineAgentFaultPlan([{ kind: 'timeout-before-first-byte', milliseconds: PAST }]),
    ).toThrow(z.ZodError);
    expect(
      defineAgentFaultPlan([
        { kind: 'timeout-before-first-byte', milliseconds: MAX_TIMER_MS },
      ]),
    ).toHaveLength(1);
  });

  test('stitchkit/geo: a reader reload interval', () => {
    expectTimerRefusal(
      () =>
        createGeoIpResolver({
          paths: {},
          loader: { revision: () => null, open: () => Promise.reject(new Error('none')) },
          reload: { intervalMs: PAST },
        }),
      'GeoIP reload intervalMs',
      PAST,
    );
  });

  test('stitchkit/release: the longest a deferred reload waits', () => {
    expectTimerRefusal(
      () => createReleaseWatcher({ own: 'a', maxDeferMs: PAST, host: {} as never }),
      'Release watcher maxDeferMs',
      PAST,
      0,
    );
  });

  test('stitchkit/tracking: the heartbeat, a batch retry pause and the early vitals sample', async () => {
    expectTimerRefusal(
      () => createTrackingClient({ buildId: 'b', heartbeatMs: PAST } as never),
      'Tracking heartbeatMs',
      PAST,
    );
    let requested = 0;
    await expectTimerRejection(
      deliverTrackingBatch({
        request: () => {
          requested += 1;
          return Promise.resolve();
        },
        onFailure: () => undefined,
        retryDelayMs: PAST,
      }),
      'Tracking retryDelayMs',
      PAST,
      0,
    );
    expect(requested).toBe(0);
    expectTimerRefusal(
      () => createPerformanceCollector({ buildId: 'b', url: '/rum', earlyDelayMs: PAST }),
      'Performance collector earlyDelayMs',
      PAST,
      0,
    );
  });

  test('stitchkit/server: the Unix client header deadline', () => {
    expectTimerRefusal(
      () => createUnixClientTransport({ socketPath: '/tmp/x.sock', headersTimeoutMs: PAST }),
      'headersTimeoutMs',
      PAST,
    );
  });

  test('stitchkit/files: the inspection deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-timer-taken-'));
    try {
      await expectTimerRejection(
        createManagedFileBoundary({ root, inspectionTimeoutMs: PAST }),
        'inspectionTimeoutMs',
        PAST,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
