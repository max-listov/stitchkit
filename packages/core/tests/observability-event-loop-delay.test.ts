import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  DEFAULT_REPEAT_MAX_KINDS,
  DEFAULT_REPEAT_WINDOW_MS,
  repeatLimited,
} from '../src/entrypoints/index';
import {
  createEventLoopDelayMonitor,
  DEFAULT_EVENT_LOOP_DELAY_BUCKET_MS,
  DEFAULT_EVENT_LOOP_DELAY_RESOLUTION_MS,
  DEFAULT_EVENT_LOOP_DELAY_WINDOW_MS,
  type EventLoopDelayClock,
  type EventLoopDelayHistogram,
  MAX_EVENT_LOOP_DELAY_BUCKETS,
} from '../src/entrypoints/observability';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';
import { expectTimerRefusal } from './support/timer-refusal';

reapAfterEachTest();

interface FakeHistogram extends EventLoopDelayHistogram {
  count: number;
  max: number;
  p99Ns: number;
  enabled: boolean;
  enableCalls: number;
  disableCalls: number;
  resetCalls: number;
}

function createFakeHistogram(initial?: {
  count?: number;
  maxNs?: number;
  p99Ns?: number;
}): FakeHistogram {
  const hist: FakeHistogram = {
    count: initial?.count ?? 0,
    max: initial?.maxNs ?? 0,
    p99Ns: initial?.p99Ns ?? 0,
    enabled: false,
    enableCalls: 0,
    disableCalls: 0,
    resetCalls: 0,
    percentile(p: number) {
      return p === 99 ? hist.p99Ns : 0;
    },
    enable() {
      hist.enabled = true;
      hist.enableCalls += 1;
    },
    disable() {
      hist.enabled = false;
      hist.disableCalls += 1;
    },
    reset() {
      hist.resetCalls += 1;
      hist.count = 0;
      hist.max = 0;
      hist.p99Ns = 0;
    },
  };
  return hist;
}

function createFakeIntervalClock(startMs = 10_000): {
  clock: EventLoopDelayClock;
  now: () => number;
  setNow: (ms: number) => void;
  tick: (advanceMs?: number) => void;
  intervalMs: () => number | null;
  cancelCount: () => number;
} {
  let current = startMs;
  let scheduledCallback: (() => void) | null = null;
  let scheduledInterval: number | null = null;
  let cancelled = 0;

  return {
    clock: {
      now: () => current,
      setInterval(cb, ms) {
        scheduledCallback = cb;
        scheduledInterval = ms;
        return () => {
          cancelled += 1;
          scheduledCallback = null;
        };
      },
    },
    now: () => current,
    setNow(ms) {
      current = ms;
    },
    tick(advanceMs) {
      current += advanceMs ?? scheduledInterval ?? 0;
      scheduledCallback?.();
    },
    intervalMs: () => scheduledInterval,
    cancelCount: () => cancelled,
  };
}

describe('observability event-loop-delay monitor', () => {
  test('protects against Node empty-histogram 511 ns bug and Bun p99 > max quantization bug', () => {
    expect(DEFAULT_EVENT_LOOP_DELAY_WINDOW_MS).toBe(300_000);
    expect(DEFAULT_EVENT_LOOP_DELAY_BUCKET_MS).toBe(10_000);
    expect(DEFAULT_EVENT_LOOP_DELAY_RESOLUTION_MS).toBe(20);
    expect(MAX_EVENT_LOOP_DELAY_BUCKETS).toBe(3_600);

    // Node empty-histogram bug: count === 0 while percentile(99) === 511 ns
    const hist = createFakeHistogram({ count: 0, maxNs: 511, p99Ns: 511 });
    const fakeClock = createFakeIntervalClock();
    const resolutions: number[] = [];

    const monitor = createEventLoopDelayMonitor({
      windowMs: 30_000,
      bucketMs: 10_000,
      resolutionMs: 15,
      clock: fakeClock.clock,
      createHistogram(res) {
        resolutions.push(res);
        return hist;
      },
    });

    expect(resolutions).toEqual([15]);
    expect(hist.enabled).toBe(true);
    expect(fakeClock.intervalMs()).toBe(10_000);
    expect(monitor.snapshot()).toEqual({
      p99Ms: 0,
      maxMs: 0,
      buckets: 0,
      windowMs: 30_000,
      bucketMs: 10_000,
    });

    // Bun quantization bug: percentile(99) reports higher than max -> clamped to max
    hist.count = 12;
    hist.max = 25_000_000; // 25 ms
    hist.p99Ns = 27_500_000; // 27.5 ms (> max)
    expect(monitor.snapshot()).toEqual({
      p99Ms: 25,
      maxMs: 25,
      buckets: 1,
      windowMs: 30_000,
      bucketMs: 10_000,
    });
    // Live snapshot MUST NOT reset the histogram
    expect(hist.resetCalls).toBe(0);

    monitor.close();
  });

  test('rotates O(1) ring buffer, expires spikes after windowMs, handles clock jumps, and closes idempotently', () => {
    const hist = createFakeHistogram();
    const fakeClock = createFakeIntervalClock(100_000);

    const monitor = createEventLoopDelayMonitor({
      windowMs: 30_000,
      bucketMs: 10_000,
      clock: fakeClock.clock,
      createHistogram: () => hist,
    });

    // Bucket 1: big spike 80ms max / 60ms p99
    hist.count = 10;
    hist.max = 80_000_000;
    hist.p99Ns = 60_000_000;
    fakeClock.tick(10_000); // recordedAt = 110_000
    expect(hist.resetCalls).toBe(1);

    // Bucket 2: small 5ms max / 4ms p99
    hist.count = 10;
    hist.max = 5_000_000;
    hist.p99Ns = 4_000_000;
    fakeClock.tick(10_000); // recordedAt = 120_000

    // Both buckets active inside 30s window
    expect(monitor.snapshot()).toMatchObject({ p99Ms: 60, maxMs: 80, buckets: 2 });

    // Bucket 3: small 3ms max / 2ms p99
    hist.count = 5;
    hist.max = 3_000_000;
    hist.p99Ns = 2_000_000;
    fakeClock.tick(10_000); // recordedAt = 130_000 (spike at 110_000 is age 20_000 < 30_000)
    expect(monitor.snapshot()).toMatchObject({ p99Ms: 60, maxMs: 80, buckets: 3 });

    // Advance clock to 140_000 (age of bucket 1 = 30_000 >= windowMs) WITHOUT ticking -> instant expiry!
    fakeClock.setNow(140_000);
    expect(monitor.snapshot()).toMatchObject({ p99Ms: 4, maxMs: 5, buckets: 2 });

    // Forward clock jump (+500_000 ms) immediately expires all old buckets
    fakeClock.setNow(640_000);
    expect(monitor.snapshot()).toMatchObject({ p99Ms: 0, maxMs: 0, buckets: 0 });

    // Backward clock jump invalidates future-stamped buckets
    hist.count = 5;
    hist.max = 40_000_000;
    hist.p99Ns = 35_000_000;
    fakeClock.tick(10_000); // recordedAt = 650_000
    expect(monitor.snapshot()).toMatchObject({ p99Ms: 35, maxMs: 40, buckets: 1 });
    fakeClock.setNow(600_000); // clock jumped backward before recordedAt
    expect(monitor.snapshot()).toMatchObject({ p99Ms: 0, maxMs: 0, buckets: 0 });

    // Idempotent close() disables histogram and cancels timer once
    hist.count = 3;
    hist.max = 99_000_000;
    hist.p99Ns = 99_000_000;
    monitor.close();
    monitor.close();
    expect(hist.disableCalls).toBe(1);
    expect(fakeClock.cancelCount()).toBe(1);
    // Live histogram is not consulted after close()
    expect(monitor.snapshot()).toMatchObject({ p99Ms: 0, maxMs: 0, buckets: 0 });
  });

  test('validates options (I10 bucket cap) and fails loud when perf_hooks is unavailable', () => {
    const dummy = () => createFakeHistogram();

    expect(() => createEventLoopDelayMonitor({ windowMs: 0, createHistogram: dummy })).toThrow(
      TypeError,
    );
    expect(() =>
      createEventLoopDelayMonitor({ bucketMs: -10, createHistogram: dummy }),
    ).toThrow(RangeError);
    // The bucket is the rotation timer: past the timer ceiling it would fire at once.
    expectTimerRefusal(
      () =>
        createEventLoopDelayMonitor({
          windowMs: 2 ** 31,
          bucketMs: 2 ** 31,
          createHistogram: dummy,
        }),
      'bucketMs',
      2 ** 31,
    );
    expect(() =>
      createEventLoopDelayMonitor({ resolutionMs: 1.5, createHistogram: dummy }),
    ).toThrow(TypeError);
    expect(() =>
      createEventLoopDelayMonitor({
        windowMs: 5_000,
        bucketMs: 10_000,
        createHistogram: dummy,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createEventLoopDelayMonitor({
        windowMs: (MAX_EVENT_LOOP_DELAY_BUCKETS + 1) * 1_000,
        bucketMs: 1_000,
        createHistogram: dummy,
      }),
    ).toThrow(RangeError);

    // Fail-loud when perf_hooks is absent and no createHistogram is injected
    const original = Reflect.get(process, 'getBuiltinModule');
    Object.defineProperty(process, 'getBuiltinModule', {
      value: () => undefined,
      configurable: true,
      writable: true,
    });
    try {
      expect(() => createEventLoopDelayMonitor()).toThrow(/perf_hooks/i);
    } finally {
      Object.defineProperty(process, 'getBuiltinModule', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  test('works against live perf_hooks.monitorEventLoopDelay without leaking p99 > max', async () => {
    const monitor = createEventLoopDelayMonitor({
      windowMs: 10_000,
      bucketMs: 1_000,
      resolutionMs: 10,
    });
    try {
      // Wait briefly so the live histogram records samples
      await new Promise((r) => setTimeout(r, 40));
      const snap = monitor.snapshot();
      expect(Number.isFinite(snap.p99Ms)).toBe(true);
      expect(Number.isFinite(snap.maxMs)).toBe(true);
      expect(snap.p99Ms).toBeGreaterThanOrEqual(0);
      expect(snap.maxMs).toBeGreaterThanOrEqual(snap.p99Ms);
      expect(snap.windowMs).toBe(10_000);
      expect(snap.bucketMs).toBe(1_000);
    } finally {
      monitor.close();
    }
  });

  test('unref() lets a child process exit cleanly even without calling monitor.close()', async () => {
    const entryPath = resolve(import.meta.dir, '../src/entrypoints/observability.ts');
    const script = `
      import { createEventLoopDelayMonitor } from ${JSON.stringify(entryPath)};
      const m = createEventLoopDelayMonitor({ windowMs: 300_000, bucketMs: 60_000 });
      const snap = m.snapshot();
      if (snap.windowMs !== 300_000) process.exit(2);
    `;
    const proc = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    trackProcess(proc.pid);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([
        proc.exited.then((code) => ({ timedOut: false as const, code })),
        new Promise<{ timedOut: true }>((res) => {
          timeoutId = setTimeout(() => res({ timedOut: true }), 5_000);
        }),
      ]);
      expect(exited.timedOut).toBe(false);
      if (!exited.timedOut) {
        expect(exited.code).toBe(0);
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  });

  test('repeatLimited is re-exported from browser-safe root stitchkit entrypoint', () => {
    expect(DEFAULT_REPEAT_WINDOW_MS).toBe(60_000);
    expect(DEFAULT_REPEAT_MAX_KINDS).toBe(256);
    const records: Array<{ level: string; msg: string }> = [];
    const wrapped = repeatLimited(
      {
        debug: (msg) => records.push({ level: 'debug', msg }),
        info: (msg) => records.push({ level: 'info', msg }),
        warn: (msg) => records.push({ level: 'warn', msg }),
        error: (msg) => records.push({ level: 'error', msg }),
      },
      { windowMs: 1_000, now: () => 5_000 },
    );
    wrapped.warn('retry 1 failed');
    wrapped.warn('retry 2 failed');
    expect(records).toHaveLength(1);
  });
});
