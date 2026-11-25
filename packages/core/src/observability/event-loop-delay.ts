import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { isRecord } from '../internal/typed';

/** Default sliding window for event-loop delay snapshots (5 minutes). */
export const DEFAULT_EVENT_LOOP_DELAY_WINDOW_MS = 300_000;

/** Default bucket rotation interval in milliseconds (10 seconds). */
export const DEFAULT_EVENT_LOOP_DELAY_BUCKET_MS = 10_000;

/** Default sampling resolution passed to `monitorEventLoopDelay` (20 milliseconds). */
export const DEFAULT_EVENT_LOOP_DELAY_RESOLUTION_MS = 20;

/** Maximum number of ring-buffer buckets permitted (`Math.ceil(windowMs / bucketMs)`). */
export const MAX_EVENT_LOOP_DELAY_BUCKETS = 3_600;

/**
 * Structural subset of `perf_hooks.IntervalHistogram` — declared without
 * `@types/node` so public `.d.ts` declarations remain portable.
 */
export interface EventLoopDelayHistogram {
  readonly count: number;
  readonly max: number;
  percentile(percentile: number): number;
  enable(): void;
  disable(): void;
  reset(): void;
}

/** Injectable clock and periodic interval boundary for deterministic tests. */
export interface EventLoopDelayClock {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): () => void;
}

/** Options for {@link createEventLoopDelayMonitor}. */
export interface EventLoopDelayMonitorOptions {
  /** Sliding window length in milliseconds (default: `300_000`). */
  readonly windowMs?: number;
  /** Bucket rotation interval in milliseconds (default: `10_000`). */
  readonly bucketMs?: number;
  /** Sampling resolution passed to `monitorEventLoopDelay` in milliseconds (default: `20`). */
  readonly resolutionMs?: number;
  /** Optional histogram factory (defaults to lazy `process.getBuiltinModule('perf_hooks')`). */
  readonly createHistogram?: (resolutionMs: number) => EventLoopDelayHistogram;
  /** Optional clock and interval scheduler (defaults to `Date.now` + unref'd `setInterval`). */
  readonly clock?: EventLoopDelayClock;
}

/** Windowed event-loop delay snapshot in milliseconds. */
export interface EventLoopDelaySnapshot {
  /** Highest p99 delay in milliseconds across active buckets in the sliding window (`0` when empty). */
  readonly p99Ms: number;
  /** Highest max delay in milliseconds across active buckets in the sliding window (`0` when empty). */
  readonly maxMs: number;
  /** Number of non-expired sampled buckets contributing to this snapshot (including the live bucket). */
  readonly buckets: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}

/** Windowed event-loop delay monitor handle. */
export interface EventLoopDelayMonitor {
  snapshot(): EventLoopDelaySnapshot;
  /** Disable the underlying histogram and cancel the rotation timer. Idempotent. */
  close(): void;
}

interface BucketSample {
  readonly recordedAt: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

function isHistogram(value: unknown): value is EventLoopDelayHistogram {
  return (
    isRecord(value) &&
    typeof value.count === 'number' &&
    typeof value.max === 'number' &&
    typeof value.percentile === 'function' &&
    typeof value.enable === 'function' &&
    typeof value.disable === 'function' &&
    typeof value.reset === 'function'
  );
}

function defaultCreateHistogram(resolutionMs: number): EventLoopDelayHistogram {
  const proc: unknown = Reflect.get(globalThis, 'process');
  if (isRecord(proc) && typeof proc.getBuiltinModule === 'function') {
    const mod: unknown = Reflect.apply(proc.getBuiltinModule, proc, ['perf_hooks']);
    const monitorFn = isRecord(mod) ? mod.monitorEventLoopDelay : undefined;
    if (typeof monitorFn === 'function') {
      const histogram: unknown = Reflect.apply(monitorFn, mod, [{ resolution: resolutionMs }]);
      if (isHistogram(histogram)) return histogram;
    }
  }
  throw new Error(
    '[stitchkit] EventLoopDelayMonitor requires process.getBuiltinModule("perf_hooks").monitorEventLoopDelay or an explicit createHistogram option',
  );
}

function createDefaultClock(): EventLoopDelayClock {
  return {
    now: () => Date.now(),
    setInterval(callback, intervalMs) {
      const timer = globalThis.setInterval(callback, intervalMs);
      if (
        typeof timer === 'object' &&
        timer !== null &&
        'unref' in timer &&
        typeof timer.unref === 'function'
      ) {
        timer.unref();
      }
      return () => globalThis.clearInterval(timer);
    },
  };
}

function readHistogramSample(
  histogram: EventLoopDelayHistogram,
  recordedAt: number,
): BucketSample | null {
  // Node's empty HDR histogram (count === 0) reports percentile(99) === 511 ns.
  if (!Number.isFinite(histogram.count) || histogram.count <= 0) return null;
  const rawMaxNs = histogram.max;
  const rawP99Ns = histogram.percentile(99);
  const maxMs = Number.isFinite(rawMaxNs) && rawMaxNs > 0 ? rawMaxNs / 1e6 : 0;
  const rawP99Ms = Number.isFinite(rawP99Ns) && rawP99Ns > 0 ? rawP99Ns / 1e6 : 0;
  // Bun's HDR histogram quantization can report p99 slightly above max.
  const p99Ms = Math.min(rawP99Ms, maxMs);
  return { recordedAt, p99Ms, maxMs };
}

/**
 * Create a sliding-window event-loop delay monitor backed by an O(1) ring
 * buffer of fixed-duration buckets (avoiding lifetime-max staleness in health
 * checks), lazy `perf_hooks` resolution, and an `unref()`'d rotation timer.
 */
export function createEventLoopDelayMonitor(
  options: EventLoopDelayMonitorOptions = {},
): EventLoopDelayMonitor {
  const windowMs = options.windowMs ?? DEFAULT_EVENT_LOOP_DELAY_WINDOW_MS;
  const bucketMs = options.bucketMs ?? DEFAULT_EVENT_LOOP_DELAY_BUCKET_MS;
  const resolutionMs = options.resolutionMs ?? DEFAULT_EVENT_LOOP_DELAY_RESOLUTION_MS;

  assertPositiveSafeInteger('windowMs', windowMs);
  assertTimerMs('bucketMs', bucketMs);
  assertPositiveSafeInteger('resolutionMs', resolutionMs);

  if (bucketMs > windowMs) {
    throw new RangeError(`bucketMs (${bucketMs}) must not exceed windowMs (${windowMs})`);
  }
  const capacity = Math.ceil(windowMs / bucketMs);
  if (capacity > MAX_EVENT_LOOP_DELAY_BUCKETS) {
    throw new RangeError(
      `EventLoopDelayMonitor bucket count (${capacity}) exceeds MAX_EVENT_LOOP_DELAY_BUCKETS (${MAX_EVENT_LOOP_DELAY_BUCKETS})`,
    );
  }

  const clock = options.clock ?? createDefaultClock();
  const histogram = (options.createHistogram ?? defaultCreateHistogram)(resolutionMs);
  const ring: Array<BucketSample | undefined> = Array.from({ length: capacity });
  let cursor = 0;
  let closed = false;

  histogram.enable();
  let cancelTimer: () => void;
  try {
    cancelTimer = clock.setInterval(() => {
      if (closed) return;
      const sample = readHistogramSample(histogram, clock.now());
      histogram.reset();
      ring[cursor] = sample ?? undefined;
      cursor = (cursor + 1) % capacity;
    }, bucketMs);
  } catch (error) {
    histogram.disable();
    throw error;
  }

  return {
    snapshot(): EventLoopDelaySnapshot {
      const now = clock.now();
      let p99Ms = 0;
      let maxMs = 0;
      let buckets = 0;

      for (let index = 0; index < capacity; index += 1) {
        const slot = ring[index];
        if (slot === undefined) continue;
        const age = now - slot.recordedAt;
        if (age < 0 || age >= windowMs) {
          ring[index] = undefined;
          continue;
        }
        if (slot.p99Ms > p99Ms) p99Ms = slot.p99Ms;
        if (slot.maxMs > maxMs) maxMs = slot.maxMs;
        buckets += 1;
      }

      if (!closed) {
        const live = readHistogramSample(histogram, now);
        if (live !== null) {
          if (live.p99Ms > p99Ms) p99Ms = live.p99Ms;
          if (live.maxMs > maxMs) maxMs = live.maxMs;
          buckets += 1;
        }
      }

      return { p99Ms, maxMs, buckets, windowMs, bucketMs };
    },
    close(): void {
      if (closed) return;
      closed = true;
      cancelTimer();
      histogram.disable();
    },
  };
}
