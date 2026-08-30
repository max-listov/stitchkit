import { describe, expect, test } from 'bun:test';
import { createApplication } from '../src/application/kernel';
import { defineManagedResource } from '../src/application/resource';
import { createServer } from '../src/server';
import {
  bindProcessSignals,
  type ProcessSignalName,
  type ShutdownTarget,
  type SignalSource,
} from '../src/server/process-signals';
import type { ShutdownOptions, ShutdownResult } from '../src/server/shutdown';
import { ShutdownOptionsSchema } from '../src/server/shutdown';

const cleanResult: ShutdownResult = {
  outcome: 'clean',
  acceptedRequests: 0,
  completedRequests: 0,
  pendingRequests: 0,
  pendingWebSockets: 0,
  pendingRequestsAtForce: 0,
  pendingWebSocketsAtForce: 0,
  abortedRequests: 0,
  forcedWebSockets: 0,
  durationMs: 1,
};

function createSource() {
  const listeners = new Map<ProcessSignalName, Set<() => void>>();
  const source: SignalSource = {
    on: (signal, handler) => {
      const set = listeners.get(signal) ?? new Set();
      set.add(handler);
      listeners.set(signal, set);
    },
    off: (signal, handler) => {
      listeners.get(signal)?.delete(handler);
    },
    raiseDefault: () => true,
  };
  return {
    source,
    send: (signal: ProcessSignalName) => {
      for (const handler of [...(listeners.get(signal) ?? [])]) handler();
    },
  };
}

describe('the declared shutdown budget on the signal path', () => {
  test('a signal spends the budget the application declared', async () => {
    // Read from inside the graph, where the budget is a fact rather than an
    // argument: `deadlineAt - now()` is exactly the grace the kernel handed
    // out. With the defaults leaking through it is 30_000, and an application
    // that declared five seconds quietly takes thirty-five.
    let observedGraceMs: number | undefined;
    let observedForceMs: number | undefined;
    const app = createApplication({
      id: 'declared-budget',
      resources: [
        defineManagedResource({
          id: 'reader',
          start: () => undefined,
          stopAdmission: (context) => {
            const now = context.now();
            observedGraceMs = (context.deadlineAt ?? now) - now;
            observedForceMs = (context.forceDeadlineAt ?? now) - (context.deadlineAt ?? now);
          },
        }),
      ],
      shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 },
    });
    await app.start();

    const signals = createSource();
    const binding = bindProcessSignals(app, { signalSource: signals.source });
    signals.send('SIGINT');
    await binding.promise;

    expect(observedGraceMs).toBeGreaterThan(4_000);
    expect(observedGraceMs).toBeLessThanOrEqual(5_000);
    // Exact arithmetic on two float deadlines, so compared as a float: the
    // question is which budget was applied, not how long the phase took.
    expect(observedForceMs).toBeCloseTo(1_000, 6);
  });

  test('a budget nobody passed never reaches shutdown()', async () => {
    const calls: (ShutdownOptions | undefined)[] = [];
    const handle: ShutdownTarget = {
      shutdown: (options) => {
        calls.push(options);
        return Promise.resolve(cleanResult);
      },
    };
    const signals = createSource();
    const binding = bindProcessSignals(handle, { signalSource: signals.source });
    signals.send('SIGTERM');
    await binding.promise;

    const passed = calls[0] ?? {};
    expect(Object.keys(passed).sort()).toEqual(['signal']);
    // Not merely "undefined": an explicit `gracePeriodMs: undefined` would
    // survive the `requested.gracePeriodMs ?? budget` merge as a key and defeat
    // the fallback just as surely as a number.
    expect('gracePeriodMs' in passed).toBe(false);
    expect('forceTimeoutMs' in passed).toBe(false);
    expect('retryAfterSeconds' in passed).toBe(false);
  });

  test('a budget that was passed still overrides the declared one', async () => {
    let observedGraceMs: number | undefined;
    const app = createApplication({
      id: 'explicit-budget',
      resources: [
        defineManagedResource({
          id: 'reader',
          start: () => undefined,
          stopAdmission: (context) => {
            const now = context.now();
            observedGraceMs = (context.deadlineAt ?? now) - now;
          },
        }),
      ],
      shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 },
    });
    await app.start();

    const signals = createSource();
    const binding = bindProcessSignals(app, {
      signalSource: signals.source,
      shutdown: { gracePeriodMs: 250 },
    });
    signals.send('SIGINT');
    await binding.promise;

    expect(observedGraceMs).toBeGreaterThan(0);
    expect(observedGraceMs).toBeLessThanOrEqual(250);
  });

  test('one passed key does not drag the other away from the declaration', async () => {
    let observedForceMs: number | undefined;
    const app = createApplication({
      id: 'half-passed',
      resources: [
        defineManagedResource({
          id: 'reader',
          start: () => undefined,
          stopAdmission: (context) => {
            const now = context.now();
            observedForceMs = (context.forceDeadlineAt ?? now) - (context.deadlineAt ?? now);
          },
        }),
      ],
      shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 },
    });
    await app.start();

    const signals = createSource();
    const binding = bindProcessSignals(app, {
      signalSource: signals.source,
      shutdown: { gracePeriodMs: 250 },
    });
    signals.send('SIGINT');
    await binding.promise;

    // Exact arithmetic on two float deadlines, so compared as a float: the
    // question is which budget was applied, not how long the phase took.
    expect(observedForceMs).toBeCloseTo(1_000, 6);
  });

  test('an invalid budget still fails at binding time, not at the signal', () => {
    const handle: ShutdownTarget = { shutdown: () => Promise.resolve(cleanResult) };
    expect(() =>
      bindProcessSignals(handle, {
        signalSource: createSource().source,
        shutdown: { gracePeriodMs: -1 },
      }),
    ).toThrow();
  });

  test('a managed server is unaffected: it applies the same defaults itself', async () => {
    // Why the defect hid for so long. Forwarding nothing is invisible to a
    // server, because the server parses whatever it is handed through the same
    // schema. Only an application — which falls back to its own declared budget
    // where the caller said nothing — could tell the two apart.
    const parsed: ShutdownOptions[] = [];
    const handle: ShutdownTarget = {
      shutdown: (options) => {
        parsed.push(ShutdownOptionsSchema.parse(options ?? {}));
        return Promise.resolve(cleanResult);
      },
    };
    const signals = createSource();
    const binding = bindProcessSignals(handle, { signalSource: signals.source });
    signals.send('SIGTERM');
    await binding.promise;

    expect(parsed[0]).toMatchObject({
      gracePeriodMs: 30_000,
      forceTimeoutMs: 5_000,
      retryAfterSeconds: 5,
    });
  });

  test('a real managed server still stops cleanly on a signal with no budget passed', async () => {
    const server = createServer({ port: 0, services: [] });
    const signals = createSource();
    const binding = bindProcessSignals(server, { signalSource: signals.source });
    signals.send('SIGTERM');
    const result = await binding.promise;
    expect(result?.outcome).toBe('clean');
    await expect(fetch(server.url)).rejects.toThrow();
  });

  test('every budget the schema declares is forwarded conditionally', () => {
    // The forwarding is written out key by key, which is readable and cannot
    // grow by itself. A fourth budget added to the schema would be silently
    // dropped on the signal path — the same class of defect as the one this
    // file exists for — so the drift is a red test rather than a review habit.
    const declared = Object.keys(ShutdownOptionsSchema.shape)
      .filter((key) => key !== 'signal')
      .sort();
    expect(declared).toEqual([
      'forceTimeoutMs',
      'gracePeriodMs',
      'realtimeCloseTimeoutMs',
      'retryAfterSeconds',
    ]);
  });
});
