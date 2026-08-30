import { describe, expect, test } from 'bun:test';
import {
  createServerLifecycle,
  type ShutdownAdapter,
  ShutdownOptionsSchema,
} from '../src/server/shutdown';

function createAdapter(overrides: Partial<ShutdownAdapter> = {}): ShutdownAdapter {
  return {
    beginShutdown() {
      // no-op
    },
    pendingRequests: () => 0,
    pendingWebSockets: () => 0,
    closeRealtime: () => Promise.resolve(),
    terminateRealtime: () => Promise.resolve(0),
    stopGracefully: () => Promise.resolve(),
    forceStop: () => Promise.resolve(),
    ...overrides,
  };
}

describe('managed server lifecycle failure containment', () => {
  test('the public options keep separate graceful and forced-completion budgets', () => {
    expect(ShutdownOptionsSchema.parse({})).toMatchObject({
      gracePeriodMs: 30_000,
      realtimeCloseTimeoutMs: 1_000,
      forceTimeoutMs: 5_000,
    });
  });

  test('graceful phases share one total budget instead of restarting the deadline', async () => {
    const adapter = createAdapter({
      closeRealtime: () => new Promise((resolve) => setTimeout(resolve, 20)),
      stopGracefully: () => new Promise(() => undefined),
    });
    const lifecycle = createServerLifecycle(() => adapter);
    const beganAt = performance.now();

    const result = await lifecycle.shutdown({ gracePeriodMs: 30, forceTimeoutMs: 1_000 });

    expect(result.outcome).toBe('forced');
    expect(result.reason).toBe('deadline');
    expect(performance.now() - beganAt).toBeLessThan(500);
  });

  test('bounds an uncooperative realtime close without spending the application grace', async () => {
    let pendingWebSockets = 1;
    let terminateCalls = 0;
    const adapter = createAdapter({
      pendingWebSockets: () => pendingWebSockets,
      closeRealtime: () => new Promise(() => undefined),
      terminateRealtime: () => {
        terminateCalls += 1;
        pendingWebSockets = 0;
        return Promise.resolve(1);
      },
    });
    const lifecycle = createServerLifecycle(() => adapter);
    const beganAt = performance.now();

    const result = await lifecycle.shutdown({
      gracePeriodMs: 2_000,
      realtimeCloseTimeoutMs: 20,
      forceTimeoutMs: 1_000,
    });

    expect(result.outcome).toBe('clean');
    expect(result.pendingWebSocketsAtForce).toBe(0);
    expect(result.forcedWebSockets).toBe(1);
    expect(result.pendingWebSockets).toBe(0);
    expect(terminateCalls).toBe(1);
    expect(performance.now() - beganAt).toBeGreaterThanOrEqual(15);
    expect(performance.now() - beganAt).toBeLessThan(500);
  });

  test('a cooperative realtime peer closes without bounded termination', async () => {
    let pendingWebSockets = 1;
    let terminateCalls = 0;
    const adapter = createAdapter({
      pendingWebSockets: () => pendingWebSockets,
      closeRealtime: () => {
        pendingWebSockets = 0;
        return Promise.resolve();
      },
      terminateRealtime: () => {
        terminateCalls += 1;
        return Promise.resolve(0);
      },
    });
    const lifecycle = createServerLifecycle(() => adapter);

    const result = await lifecycle.shutdown({
      gracePeriodMs: 2_000,
      realtimeCloseTimeoutMs: 20,
    });

    expect(result.outcome).toBe('clean');
    expect(result.forcedWebSockets).toBe(0);
    expect(terminateCalls).toBe(0);
  });

  test('the outer deadline stays authoritative over the realtime bound', async () => {
    let pendingWebSockets = 1;
    let boundedTerminateCalls = 0;
    const adapter = createAdapter({
      pendingWebSockets: () => pendingWebSockets,
      closeRealtime: () => new Promise(() => undefined),
      terminateRealtime: () => {
        boundedTerminateCalls += 1;
        return Promise.resolve(1);
      },
      forceStop: () => {
        pendingWebSockets = 0;
        return Promise.resolve();
      },
    });
    const lifecycle = createServerLifecycle(() => adapter);

    const result = await lifecycle.shutdown({
      gracePeriodMs: 10,
      realtimeCloseTimeoutMs: 1_000,
      forceTimeoutMs: 1_000,
    });

    expect(result.outcome).toBe('forced');
    expect(result.reason).toBe('deadline');
    expect(result.pendingWebSocketsAtForce).toBe(1);
    expect(result.forcedWebSockets).toBe(1);
    expect(boundedTerminateCalls).toBe(0);
  });

  for (const phase of ['closeRealtime', 'stopGracefully'] satisfies Array<
    'closeRealtime' | 'stopGracefully'
  >) {
    test(`${phase} failure still forces transport cleanup and preserves the original error`, async () => {
      const phaseError = new Error(`${phase} failed`);
      let forceCalls = 0;
      const adapter = createAdapter({
        [phase]: () => Promise.reject(phaseError),
        forceStop: () => {
          forceCalls += 1;
          return Promise.resolve();
        },
      });
      const lifecycle = createServerLifecycle(() => adapter);

      try {
        await lifecycle.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 1_000 });
        throw new Error('shutdown unexpectedly resolved');
      } catch (error) {
        expect(error).toBe(phaseError);
      }
      expect(forceCalls).toBe(1);
      expect(lifecycle.status.state).toBe('forced');
    });
  }

  test('a non-settling forced adapter rejects within its explicit completion timeout', async () => {
    const adapter = createAdapter({
      pendingWebSockets: () => 1,
      forceStop: () => new Promise(() => undefined),
    });
    const lifecycle = createServerLifecycle(() => adapter);
    const controller = new AbortController();
    controller.abort();
    const beganAt = performance.now();

    await expect(
      lifecycle.shutdown({
        gracePeriodMs: 10_000,
        forceTimeoutMs: 20,
        signal: controller.signal,
      }),
    ).rejects.toThrow('[stitchkit] forced shutdown did not complete within 20ms');
    expect(performance.now() - beganAt).toBeLessThan(500);
    expect(lifecycle.status.state).toBe('forced');
    expect(lifecycle.status.pendingWebSockets).toBe(1);
  });

  test('a forced-cleanup failure retains the original graceful phase error', async () => {
    const phaseError = new Error('realtime close failed');
    const forceError = new Error('forced close failed');
    const adapter = createAdapter({
      closeRealtime: () => Promise.reject(phaseError),
      forceStop: () => Promise.reject(forceError),
    });
    const lifecycle = createServerLifecycle(() => adapter);

    try {
      await lifecycle.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 1_000 });
      throw new Error('shutdown unexpectedly resolved');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.cause).toBe(phaseError);
      expect(error.errors).toEqual([phaseError, forceError]);
    }
    expect(lifecycle.status.state).toBe('forced');
  });
});
