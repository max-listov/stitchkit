import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  bindProcessSignals,
  type ProcessSignalName,
  type SignalSource,
} from '../src/entrypoints/server';
import {
  type ConfigReloaderClock,
  type ConfigReloaderError,
  type ConfigSource,
  type ConfigSourceReading,
  createPolledJsonConfigSource,
  DEFAULT_CONFIG_POLL_INTERVAL_MS,
  DEFAULT_CONFIG_START_TIMEOUT_MS,
  DEFAULT_CONFIG_STOP_TIMEOUT_MS,
  startConfigReloader,
} from '../src/entrypoints/service-host';
import { expectTimerRejection } from './support/timer-refusal';

interface FakeTimer {
  id: number;
  at: number;
  cancelled: boolean;
  callback: () => void;
}

class FakeClock implements ConfigReloaderClock {
  private current = 1_000;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.current;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer: FakeTimer = {
      id: this.nextId,
      at: this.current + delayMs,
      cancelled: false,
      callback,
    };
    this.nextId += 1;
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  async advance(ms: number): Promise<void> {
    await flushMicrotasks();
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      next.cancelled = true;
      this.current = next.at;
      next.callback();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function createFakeSignalSource(): {
  source: SignalSource;
  emit(signal: ProcessSignalName): void;
} {
  const listeners = new Map<ProcessSignalName, Set<() => void>>();
  return {
    source: {
      on(signal, handler) {
        const set = listeners.get(signal) ?? new Set<() => void>();
        set.add(handler);
        listeners.set(signal, set);
      },
      off(signal, handler) {
        listeners.get(signal)?.delete(handler);
      },
      raiseDefault() {
        return true;
      },
    },
    emit(signal) {
      for (const handler of [...(listeners.get(signal) ?? [])]) handler();
    },
  };
}

function createScriptedSource<T>(
  readings: ConfigSourceReading<T>[],
): ConfigSource<T> & { calls: number } {
  let index = 0;
  const source: ConfigSource<T> & { calls: number } = {
    calls: 0,
    read() {
      source.calls += 1;
      const item = readings[index];
      if (index < readings.length - 1) index += 1;
      return item ?? { state: 'unchanged' };
    },
  };
  return source;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stitchkit-config-reloader-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('service-host config-reloader', () => {
  test('createPolledJsonConfigSource wraps PolledJsonFile + canonicalDigest, supports custom digest and size bounds', async () => {
    expect(DEFAULT_CONFIG_POLL_INTERVAL_MS).toBe(2_000);
    expect(DEFAULT_CONFIG_START_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_CONFIG_STOP_TIMEOUT_MS).toBe(10_000);

    const Schema = z.strictObject({ version: z.number().int().positive(), host: z.string() });
    const file = join(root, 'daemon.json');
    writeFileSync(file, '{"version":1,"host":"a"}');

    const source = createPolledJsonConfigSource({
      path: file,
      schema: Schema,
      maxBytes: 1024,
      maxCacheBytes: 2048,
    });

    const first = await source.read();
    expect(first.state).toBe('valid');
    if (first.state !== 'valid') throw new Error('expected valid');
    expect(first.config).toEqual({ version: 1, host: 'a' });

    // Unchanged file yields unchanged
    expect(await source.read()).toEqual({ state: 'unchanged' });

    // Broken JSON yields invalid with deterministic failureKey
    writeFileSync(file, '{broken');
    const broken = await source.read();
    expect(broken.state).toBe('invalid');
    if (broken.state === 'invalid') {
      expect(broken.failureKey.length).toBeGreaterThan(0);
    }

    // Missing file yields missing
    unlinkSync(file);
    expect(await source.read()).toEqual({ state: 'missing' });

    // Restoring v1 yields the exact same digest as initial v1
    writeFileSync(file, '{"version":1,"host":"a"}');
    const restored = await source.read();
    expect(restored.state).toBe('valid');
    if (restored.state === 'valid') {
      expect(restored.digest).toBe(first.digest);
    }

    // Custom digest function is honored
    const custom = createPolledJsonConfigSource({
      path: file,
      schema: Schema,
      digest: (cfg) => `v:${cfg.version}`,
    });
    const c1 = await custom.read();
    expect(c1).toMatchObject({ state: 'valid', digest: 'v:1' });
    expect(await custom.read()).toEqual({ state: 'unchanged' });
  });

  test('validates BEFORE stop, deduplicates onInvalidConfig per failureKey, and avoids restart on v1 -> broken -> v1', async () => {
    const Schema = z.strictObject({ port: z.number().int().positive() });
    const file = join(root, 'service.json');
    writeFileSync(file, '{"port":8080}');

    const clock = new FakeClock();
    const events: string[] = [];
    const invalidLog: Array<{ detail: string; key: string }> = [];
    const errors: ConfigReloaderError[] = [];
    const reloads: string[] = [];
    let handleSeq = 0;

    const reloader = await startConfigReloader({
      source: createPolledJsonConfigSource({ path: file, schema: Schema }),
      pollIntervalMs: 500,
      clock,
      validate(cfg) {
        if (cfg.port === 1) throw new Error('port 1 is reserved');
      },
      start(cfg) {
        handleSeq += 1;
        const id = `h${handleSeq}:${cfg.port}`;
        events.push(`start:${id}`);
        return id;
      },
      stop(handle) {
        events.push(`stop:${handle}`);
      },
      onInvalidConfig(detail, failureKey) {
        invalidLog.push({ detail, key: failureKey });
      },
      onReload(digest) {
        reloads.push(digest);
      },
      onError(err) {
        errors.push(err);
      },
    });

    expect(events).toEqual(['start:h1:8080']);
    expect(reloads).toEqual([]); // onReload does not fire on initial startup

    // Write semantically invalid config (fails validate) -> must NOT stop h1, logs once per key
    writeFileSync(file, '{"port":1}');
    await clock.advance(500);
    expect(events).toEqual(['start:h1:8080']);
    expect(invalidLog).toHaveLength(1);
    expect(errors.map((e) => e.phase)).toEqual(['validate']);

    // Second poll with same invalid file stays silent on onInvalidConfig
    await clock.advance(500);
    expect(invalidLog).toHaveLength(1);

    // Syntax error has a different failureKey -> fires onInvalidConfig once
    writeFileSync(file, '{bad-json');
    await clock.advance(500);
    expect(invalidLog).toHaveLength(2);
    await clock.advance(500);
    expect(invalidLog).toHaveLength(2);

    // Restore original v1 (port 8080) -> activeDigest matches, NO restart!
    writeFileSync(file, '{"port":8080}');
    await clock.advance(500);
    expect(events).toEqual(['start:h1:8080']);
    expect(reloads).toEqual([]);
    expect(reloader.status().lastInvalidKey).toBeNull();

    // Now write valid v2 (port 9090) -> stops h1, starts h2, fires onReload
    writeFileSync(file, '{"port":9090}');
    await clock.advance(500);
    expect(events).toEqual(['start:h1:8080', 'stop:h1:8080', 'start:h2:9090']);
    expect(reloads).toHaveLength(1);
    expect(reloader.status().reloads).toBe(1);

    await reloader.shutdown();
    expect(events).toEqual(['start:h1:8080', 'stop:h1:8080', 'start:h2:9090', 'stop:h2:9090']);
  });

  test('coalesces burst triggerReload calls to 1 pending follow-up slot (O(1))', async () => {
    const clock = new FakeClock();
    let releaseStart: (() => void) | undefined;
    let currentVersion = 1;
    let reads = 0;

    const source: ConfigSource<{ v: number }> = {
      read() {
        reads += 1;
        return { state: 'valid', config: { v: currentVersion }, digest: `d${currentVersion}` };
      },
    };

    const started: number[] = [];
    const reloader = await startConfigReloader({
      source,
      clock,
      pollIntervalMs: 5_000,
      async start(cfg) {
        started.push(cfg.v);
        if (cfg.v === 2) {
          await new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
        }
        return cfg.v;
      },
      stop: () => undefined,
    });

    currentVersion = 2;
    const firstTrigger = reloader.triggerReload();
    await flushMicrotasks();
    expect(started).toEqual([1, 2]);

    // While v2 start is blocked, trigger 20 concurrent reloads and advance version to 3
    currentVersion = 3;
    const readsBeforeBurst = reads;
    const burst = Array.from({ length: 20 }, () => reloader.triggerReload());
    releaseStart?.();
    await firstTrigger;
    await Promise.all(burst);

    // Only ONE follow-up read ran for all 20 coalesced triggers!
    expect(reads - readsBeforeBurst).toBe(1);
    expect(started).toEqual([1, 2, 3]);

    await reloader.shutdown();
  });

  test('prevents hot-loop via lastFailedStartDigest and honors rollbackOnStartFailure (true vs false)', async () => {
    // Part A: rollbackOnStartFailure = true (default)
    const clockA = new FakeClock();
    let activeVersion = 1;
    const startsA: number[] = [];
    const errorsA: ConfigReloaderError[] = [];

    const reloaderA = await startConfigReloader({
      source: {
        read: () => ({
          state: 'valid',
          config: { v: activeVersion },
          digest: `d${activeVersion}`,
        }),
      },
      clock: clockA,
      pollIntervalMs: 200,
      start(cfg) {
        startsA.push(cfg.v);
        if (cfg.v === 2) throw new Error('v2 boot failed');
        return cfg.v;
      },
      stop: () => undefined,
      onError: (e) => errorsA.push(e),
    });

    activeVersion = 2;
    await clockA.advance(200);
    // Started v1, tried v2 (failed), rolled back to v1!
    expect(startsA).toEqual([1, 2, 1]);
    expect(reloaderA.status()).toMatchObject({
      state: 'running',
      activeDigest: 'd1',
      lastFailedStartDigest: 'd2',
      failedReloads: 1,
      hasActiveHandle: true,
    });
    expect(errorsA.map((e) => e.phase)).toEqual(['start']);

    // Next 3 poll ticks with same broken v2 MUST NOT retry v2 (no hot loop)
    await clockA.advance(600);
    expect(startsA).toEqual([1, 2, 1]);

    // Switching to v3 clears lastFailedStartDigest and succeeds
    activeVersion = 3;
    await clockA.advance(200);
    expect(startsA).toEqual([1, 2, 1, 3]);
    expect(reloaderA.status().activeDigest).toBe('d3');
    expect(reloaderA.status().lastFailedStartDigest).toBeNull();
    await reloaderA.shutdown();

    // Part B: rollbackOnStartFailure = false leaves reloader degraded with no handle
    const clockB = new FakeClock();
    let verB = 1;
    const startsB: number[] = [];
    const reloaderB = await startConfigReloader({
      source: { read: () => ({ state: 'valid', config: { v: verB }, digest: `d${verB}` }) },
      clock: clockB,
      pollIntervalMs: 200,
      rollbackOnStartFailure: false,
      start(cfg) {
        startsB.push(cfg.v);
        if (cfg.v === 2) throw new Error('v2 failed');
        return cfg.v;
      },
      stop: () => undefined,
    });

    verB = 2;
    await clockB.advance(200);
    expect(startsB).toEqual([1, 2]);
    expect(reloaderB.status()).toMatchObject({
      state: 'degraded',
      hasActiveHandle: false,
      lastFailedStartDigest: 'd2',
    });
    // With nothing running there is no handle to protect: the next poll tries v2 again.
    await clockB.advance(200);
    expect(startsB).toEqual([1, 2, 2]);
    await reloaderB.shutdown();
  });

  test('a stop that outlives its timeout is the only stop of that handle, and the waiting config starts when it ends', async () => {
    const clock = new FakeClock();
    const stops: number[] = [];
    const starts: number[] = [];
    const release = Promise.withResolvers<void>();
    let version = 1;

    const reloader = await startConfigReloader({
      source: {
        read: () => ({ state: 'valid', config: { v: version }, digest: `d${version}` }),
      },
      clock,
      pollIntervalMs: 500,
      stopTimeoutMs: 300,
      start(cfg) {
        starts.push(cfg.v);
        return cfg.v;
      },
      async stop(handle) {
        stops.push(handle);
        if (handle === 1) await release.promise;
      },
    });

    version = 2;
    await clock.advance(500);
    await clock.advance(300);
    // The stop of handle 1 timed out and is still running: nothing new was started.
    expect(reloader.status()).toMatchObject({ state: 'degraded', hasActiveHandle: true });
    expect(stops).toEqual([1]);
    expect(starts).toEqual([1]);

    // A poll that arrives meanwhile neither stops handle 1 again nor starts beside it.
    await clock.advance(500);
    expect(stops).toEqual([1]);
    expect(starts).toEqual([1]);

    // Shutdown waits for the stop already running instead of calling stop a second time.
    const shutdown = reloader.shutdown({ gracePeriodMs: 10_000 });
    await flushMicrotasks();
    expect(stops).toEqual([1]);
    release.resolve();
    expect((await shutdown).outcome).toBe('clean');
    expect(stops).toEqual([1]);
  });

  test('when the late stop ends before any shutdown, the config that waited behind it starts', async () => {
    const clock = new FakeClock();
    const stops: number[] = [];
    const starts: number[] = [];
    const release = Promise.withResolvers<void>();
    let version = 1;

    const reloader = await startConfigReloader({
      source: {
        read: () => ({ state: 'valid', config: { v: version }, digest: `d${version}` }),
      },
      clock,
      pollIntervalMs: 500,
      stopTimeoutMs: 300,
      start(cfg) {
        starts.push(cfg.v);
        return cfg.v;
      },
      async stop(handle) {
        stops.push(handle);
        if (handle === 1) await release.promise;
      },
    });

    version = 2;
    await clock.advance(500);
    await clock.advance(300);
    expect(starts).toEqual([1]);

    release.resolve();
    await flushMicrotasks();
    await clock.advance(0);
    expect(starts).toEqual([1, 2]);
    expect(reloader.status()).toMatchObject({
      state: 'running',
      activeDigest: 'd2',
      hasActiveHandle: true,
    });
    await reloader.shutdown();
    expect(stops).toEqual([1, 2]);
  });

  test('a start that failed with nothing running is tried again on the next poll', async () => {
    // The port is still held by the previous process: the first start fails, the second
    // finds it free. The file never changes, so only the reloader can bring this back.
    const clock = new FakeClock();
    const starts: string[] = [];
    let portFree = false;
    const source = createScriptedSource<{ v: number }>([
      { state: 'valid', config: { v: 1 }, digest: 'd1' },
      { state: 'valid', config: { v: 2 }, digest: 'd2' },
      { state: 'unchanged' },
    ]);

    const reloader = await startConfigReloader({
      source,
      clock,
      pollIntervalMs: 500,
      rollbackOnStartFailure: false,
      start(cfg) {
        if (cfg.v === 2 && !portFree) {
          starts.push('v2 refused');
          throw new Error('EADDRINUSE');
        }
        starts.push(`v${cfg.v}`);
        return cfg.v;
      },
      stop: () => undefined,
    });

    await clock.advance(500);
    expect(reloader.status()).toMatchObject({ state: 'degraded', hasActiveHandle: false });
    await clock.advance(500);
    expect(starts).toEqual(['v1', 'v2 refused', 'v2 refused']);

    portFree = true;
    await clock.advance(500);
    expect(starts).toEqual(['v1', 'v2 refused', 'v2 refused', 'v2']);
    expect(reloader.status()).toMatchObject({
      state: 'running',
      activeDigest: 'd2',
      hasActiveHandle: true,
      lastFailedStartDigest: null,
    });
    await reloader.shutdown();
  });

  test('refuses to call start(next) when stop(oldHandle) fails or exceeds stopTimeoutMs, and enforces startTimeoutMs', async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    const errors: ConfigReloaderError[] = [];
    let stopAborted = false;

    const source = createScriptedSource<{ v: number }>([
      { state: 'valid', config: { v: 1 }, digest: 'd1' },
      { state: 'valid', config: { v: 2 }, digest: 'd2' },
      { state: 'unchanged' },
    ]);

    const reloader = await startConfigReloader({
      source,
      clock,
      pollIntervalMs: 500,
      stopTimeoutMs: 300,
      start(cfg) {
        starts.push(cfg.v);
        return cfg.v;
      },
      stop(_handle, signal) {
        return new Promise<void>((_resolve) => {
          signal.addEventListener('abort', () => {
            stopAborted = true;
          });
        });
      },
      onError: (e) => errors.push(e),
    });

    const reloadPromise = reloader.triggerReload();
    await clock.advance(300);
    await reloadPromise;

    expect(stopAborted).toBe(true);
    // CRITICAL: start(v2) must NEVER have been called because stop(v1) timed out!
    expect(starts).toEqual([1]);
    expect(errors.map((e) => e.phase)).toEqual(['stop']);
    expect(reloader.status().state).toBe('degraded');
    await reloader.shutdown({ gracePeriodMs: 0 });

    // startTimeoutMs aborts a hanging start
    const clockStart = new FakeClock();
    let startAborted = false;
    const startPromise = startConfigReloader({
      source: createScriptedSource([{ state: 'valid', config: { v: 1 }, digest: 'd1' }]),
      clock: clockStart,
      startTimeoutMs: 250,
      start(_cfg, signal) {
        return new Promise<number>((_resolve) => {
          signal.addEventListener('abort', () => {
            startAborted = true;
          });
        });
      },
      stop: () => undefined,
    });
    await clockStart.advance(250);
    await expect(startPromise).rejects.toThrow(/timed out/i);
    expect(startAborted).toBe(true);
  });

  test('shutdown is idempotent, supports gracePeriodMs: 0, stops late-resolving start(next), and integrates with bindProcessSignals', async () => {
    // Part A: start(next) resolves AFTER closing starts -> newHandle is stopped immediately!
    const clock = new FakeClock();
    let resolveLateStart: ((handle: string) => void) | undefined;
    const stopped: string[] = [];
    const source = createScriptedSource<{ v: number }>([
      { state: 'valid', config: { v: 1 }, digest: 'd1' },
      { state: 'valid', config: { v: 2 }, digest: 'd2' },
    ]);

    const reloader = await startConfigReloader({
      source,
      clock,
      pollIntervalMs: 1_000,
      start(cfg) {
        if (cfg.v === 1) return 'handle-1';
        return new Promise<string>((resolve) => {
          resolveLateStart = resolve;
        });
      },
      stop(handle) {
        stopped.push(handle);
      },
    });

    const reloadTask = reloader.triggerReload();
    await flushMicrotasks();
    // handle-1 stopped, start(v2) is now pending
    expect(stopped).toEqual(['handle-1']);

    // Initiate shutdown concurrently (idempotent!)
    const s1 = reloader.shutdown({ gracePeriodMs: 500 });
    const s2 = reloader.shutdown({ gracePeriodMs: 500 });
    expect(s1).toBe(s2);

    // Late resolution of start(v2) while closing -> must immediately stop handle-2
    resolveLateStart?.('handle-2');
    const result = await s1;
    await reloadTask;
    expect(result.outcome).toBe('clean');
    expect(stopped).toEqual(['handle-1', 'handle-2']);
    expect(reloader.status().state).toBe('closed');
    expect(clock.pendingCount()).toBe(0);

    // Part B: gracePeriodMs: 0 forces immediately & rejects negative gracePeriodMs
    const clockZero = new FakeClock();
    const zeroReloader = await startConfigReloader({
      source: createScriptedSource([{ state: 'valid', config: { v: 1 }, digest: 'd1' }]),
      clock: clockZero,
      start: () => 'h0',
      stop: () => new Promise<void>(() => undefined),
    });
    await expect(zeroReloader.shutdown({ gracePeriodMs: -1 })).rejects.toThrow(RangeError);
    await expectTimerRejection(
      zeroReloader.shutdown({ gracePeriodMs: 2 ** 31 }),
      'gracePeriodMs',
      2 ** 31,
      0,
    );
    const forcedZero = await zeroReloader.shutdown({ gracePeriodMs: 0 });
    expect(forcedZero).toMatchObject({ outcome: 'forced', reason: 'deadline' });

    // Part C: real bindProcessSignals integration (first SIGTERM starts shutdown, second forces via signal)
    const clockSig = new FakeClock();
    const signals = createFakeSignalSource();
    let stopSignalAborted = false;
    const sigReloader = await startConfigReloader({
      source: createScriptedSource([{ state: 'valid', config: { v: 1 }, digest: 'd1' }]),
      clock: clockSig,
      start: () => 'sig-handle',
      stop(_h, signal) {
        return new Promise<void>((_resolve) => {
          signal.addEventListener('abort', () => {
            stopSignalAborted = true;
          });
        });
      },
    });

    const binding = bindProcessSignals(sigReloader, {
      signalSource: signals.source,
      shutdown: { gracePeriodMs: 5_000 },
    });

    signals.emit('SIGTERM');
    await flushMicrotasks();
    expect(sigReloader.status().state).toBe('closing');

    // Second SIGTERM on a later turn forces shutdown via AbortSignal
    signals.emit('SIGTERM');
    const sigResult = await binding.promise;
    expect(stopSignalAborted).toBe(true);
    expect(sigResult).toMatchObject({ outcome: 'forced', reason: 'signal' });
    binding.close();
  });

  test('stops late-resolving handles after startTimeoutMs (initial + reload) and after forced shutdown with un-aborted stop signal', async () => {
    // (a) Initial startup times out, then start() resolves late -> stop(lateHandle) runs with fresh un-aborted signal
    const clockInit = new FakeClock();
    let resolveInitStart: ((h: string) => void) | undefined;
    const stoppedInit: Array<{ handle: string; aborted: boolean }> = [];
    const initPromise = startConfigReloader({
      source: createScriptedSource([{ state: 'valid', config: { v: 1 }, digest: 'd1' }]),
      clock: clockInit,
      startTimeoutMs: 200,
      stopTimeoutMs: 500,
      start: () =>
        new Promise<string>((resolve) => {
          resolveInitStart = resolve;
        }),
      stop(handle, signal) {
        stoppedInit.push({ handle, aborted: signal.aborted });
      },
    });
    await clockInit.advance(200);
    await expect(initPromise).rejects.toThrow(/timed out/i);
    resolveInitStart?.('late-init-handle');
    await flushMicrotasks();
    expect(stoppedInit).toEqual([{ handle: 'late-init-handle', aborted: false }]);

    // (b) Reload start() times out, then resolves late while reloader is still running -> stop(lateHandle) runs!
    const clockReload = new FakeClock();
    let resolveLateReload: ((h: string) => void) | undefined;
    const stoppedReload: Array<{ handle: string; aborted: boolean }> = [];
    const reloader = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
        { state: 'unchanged' },
      ]),
      clock: clockReload,
      startTimeoutMs: 200,
      stopTimeoutMs: 500,
      rollbackOnStartFailure: false,
      start(cfg) {
        if (cfg.v === 1) return 'h1';
        return new Promise<string>((resolve) => {
          resolveLateReload = resolve;
        });
      },
      stop(handle, signal) {
        stoppedReload.push({ handle, aborted: signal.aborted });
      },
    });
    const reloadTask = reloader.triggerReload();
    await clockReload.advance(200);
    await reloadTask;
    expect(stoppedReload).toEqual([{ handle: 'h1', aborted: false }]);
    resolveLateReload?.('late-reload-handle');
    await flushMicrotasks();
    expect(stoppedReload).toEqual([
      { handle: 'h1', aborted: false },
      { handle: 'late-reload-handle', aborted: false },
    ]);
    await reloader.shutdown();

    // (c) Forced shutdown (gracePeriodMs: 0) while start(v2) is pending; later start(v2) resolves -> stopLate runs with un-aborted signal!
    const clockForced = new FakeClock();
    let resolveAfterForced: ((h: string) => void) | undefined;
    const stoppedForced: Array<{ handle: string; aborted: boolean }> = [];
    const forcedErrors: ConfigReloaderError[] = [];
    const forcedReloader = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockForced,
      start(cfg) {
        if (cfg.v === 1) return 'fh1';
        return new Promise<string>((resolve) => {
          resolveAfterForced = resolve;
        });
      },
      stop(handle, signal) {
        stoppedForced.push({ handle, aborted: signal.aborted });
      },
      onError: (e) => forcedErrors.push(e),
    });
    const forcedReloadTask = forcedReloader.triggerReload();
    await flushMicrotasks();
    const res = await forcedReloader.shutdown({ gracePeriodMs: 0 });
    await forcedReloadTask;
    expect(res).toMatchObject({ outcome: 'forced', reason: 'deadline' });

    resolveAfterForced?.('fh2-late');
    await flushMicrotasks();
    expect(stoppedForced).toEqual([
      { handle: 'fh1', aborted: false },
      { handle: 'fh2-late', aborted: false },
    ]);
    expect(forcedErrors).toEqual([]);
  });

  test('shutdown during in-flight stop(oldHandle) invokes stop(oldHandle) exactly once (forced and failing stop)', async () => {
    // (a) Forced shutdown during in-flight stop(oldHandle)
    const clockA = new FakeClock();
    let stopCallsA = 0;
    const reloaderA = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockA,
      start: (cfg) => `h${cfg.v}`,
      stop() {
        stopCallsA += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const reloadA = reloaderA.triggerReload();
    await flushMicrotasks();
    expect(stopCallsA).toBe(1);
    const forcedRes = await reloaderA.shutdown({ gracePeriodMs: 0 });
    await reloadA;
    expect(forcedRes).toMatchObject({ outcome: 'forced', reason: 'deadline' });
    expect(stopCallsA).toBe(1);

    // (b) In-flight stop(oldHandle) rejects while closing -> stop called once, error reported as phase: 'shutdown'
    const clockB = new FakeClock();
    let stopCallsB = 0;
    let rejectStopB: ((err: Error) => void) | undefined;
    const errorsB: ConfigReloaderError[] = [];
    const reloaderB = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockB,
      start: (cfg) => `h${cfg.v}`,
      stop() {
        stopCallsB += 1;
        return new Promise<void>((_res, rej) => {
          rejectStopB = rej;
        });
      },
      onError: (e) => errorsB.push(e),
    });
    const reloadB = reloaderB.triggerReload();
    await flushMicrotasks();
    expect(stopCallsB).toBe(1);
    const shutB = reloaderB.shutdown({ gracePeriodMs: 500 });
    rejectStopB?.(new Error('in-flight stop failed'));
    await shutB;
    await reloadB;
    expect(stopCallsB).toBe(1);
    expect(errorsB.map((e) => e.phase)).toEqual(['shutdown']);

    // (c) Forced shutdown when options.stop rejects reports phase: 'shutdown' to onError
    const clockC = new FakeClock();
    const errorsC: ConfigReloaderError[] = [];
    const reloaderC = await startConfigReloader({
      source: createScriptedSource([{ state: 'valid', config: { v: 1 }, digest: 'd1' }]),
      clock: clockC,
      start: () => 'hc1',
      stop: () => Promise.reject(new Error('forced stop boom')),
      onError: (e) => errorsC.push(e),
    });
    const resC = await reloaderC.shutdown({ gracePeriodMs: 0 });
    await flushMicrotasks();
    expect(resC).toMatchObject({ outcome: 'forced', reason: 'deadline' });
    expect(errorsC.map((e) => e.phase)).toEqual(['shutdown']);
  });

  test('guards sync/async observer exceptions, deduplicates validate errors, reports read/rollback errors, and validates numeric options', async () => {
    const validSource = () =>
      createScriptedSource([{ state: 'valid', config: { v: 1 }, digest: 'd1' }]);

    // The timer rule: 2 ** 31 is past the ceiling, where a timer fires at once.
    for (const [option, value] of [
      ['pollIntervalMs', 0],
      ['startTimeoutMs', -5],
      ['stopTimeoutMs', 1.5],
      ['pollIntervalMs', 2 ** 31],
      ['startTimeoutMs', 2 ** 31],
      ['stopTimeoutMs', 2 ** 31],
    ] as const) {
      await expectTimerRejection(
        startConfigReloader({
          source: validSource(),
          start: () => 'h',
          stop: () => undefined,
          [option]: value,
        }),
        option,
        value,
      );
    }

    // Non-caching source returns same invalid config repeatedly -> validate onError fires ONCE per failureKey;
    // sync + async throws in onInvalidConfig / onReload / onError never break reloader or leak unhandledRejection.
    const clock = new FakeClock();
    let mode: 'v1' | 'bad-validate' | 'read-throws' | 'v2-fail-rollback' | 'v3-ok' = 'v1';
    const phases: string[] = [];
    const invalidKeys: string[] = [];
    let failRollback = false;

    const reloader = await startConfigReloader({
      source: {
        read() {
          if (mode === 'read-throws') throw new Error('disk io failed');
          if (mode === 'bad-validate')
            return { state: 'valid', config: { v: -1 }, digest: 'dbad' };
          if (mode === 'v2-fail-rollback')
            return { state: 'valid', config: { v: 2 }, digest: 'd2' };
          if (mode === 'v3-ok') return { state: 'valid', config: { v: 3 }, digest: 'd3' };
          return { state: 'valid', config: { v: 1 }, digest: 'd1' };
        },
      },
      clock,
      pollIntervalMs: 100,
      validate(cfg) {
        if (cfg.v < 0) throw new Error('negative v');
      },
      start(cfg) {
        if (cfg.v === 2) throw new Error('v2 boot boom');
        if (cfg.v === 1 && failRollback) throw new Error('rollback boom');
        return `h${cfg.v}`;
      },
      stop: () => undefined,
      async onInvalidConfig(_detail, key) {
        invalidKeys.push(key);
        throw new Error('async invalid observer boom');
      },
      async onReload() {
        throw new Error('async reload observer boom');
      },
      onError(e) {
        phases.push(e.phase);
        throw new Error('sync error observer boom');
      },
    });

    // Repeated non-cached invalid reads -> only 1 validate error + 1 invalidKey
    mode = 'bad-validate';
    await clock.advance(100);
    await clock.advance(100);
    expect(invalidKeys).toHaveLength(1);
    expect(phases).toEqual(['validate']);

    // Source read error -> phase: 'read'
    mode = 'read-throws';
    await clock.advance(100);
    expect(phases).toEqual(['validate', 'read']);

    // Failed start + failed rollback -> phases: 'start', 'rollback', state: 'degraded'
    failRollback = true;
    mode = 'v2-fail-rollback';
    await clock.advance(100);
    expect(phases).toEqual(['validate', 'read', 'start', 'rollback']);
    expect(reloader.status().state).toBe('degraded');

    // Recover with valid v3 even when onReload rejects asynchronously
    mode = 'v3-ok';
    await clock.advance(100);
    expect(reloader.status()).toMatchObject({
      state: 'running',
      activeDigest: 'd3',
      reloads: 1,
    });

    await reloader.shutdown();
  });

  test('does not read a stateful source while a timed-out stop is in flight, so a later config change is preserved, and a shutdown during a read starts nothing', async () => {
    const clock = new FakeClock();
    const queue: ConfigSourceReading<{ v: number }>[] = [
      { state: 'valid', config: { v: 1 }, digest: 'd1' },
      { state: 'valid', config: { v: 2 }, digest: 'd2' },
    ];
    let readsWhileStopInFlight = 0;
    let stopInFlightActive = false;
    let releaseStop1: (() => void) | undefined;
    let stop1Calls = 0;
    const started: number[] = [];

    const reloader = await startConfigReloader({
      source: {
        read() {
          if (stopInFlightActive) readsWhileStopInFlight += 1;
          return queue.shift() ?? { state: 'unchanged' };
        },
      },
      clock,
      pollIntervalMs: 50,
      stopTimeoutMs: 100,
      start(cfg) {
        started.push(cfg.v);
        return cfg.v;
      },
      async stop(handle) {
        if (handle === 1) {
          stop1Calls += 1;
          await new Promise<void>((resolve) => {
            releaseStop1 = resolve;
          });
        }
      },
    });

    // Trigger reload to v2 -> stop(1) exceeds stopTimeoutMs (100ms), entering stopInFlight.
    const timedOutReload = reloader.triggerReload();
    await clock.advance(100);
    await timedOutReload;
    expect(reloader.status().state).toBe('degraded');
    expect(stop1Calls).toBe(1);

    // While stop(1) is still in flight, v3 becomes available in the edge-triggered source.
    stopInFlightActive = true;
    queue.push({ state: 'valid', config: { v: 3 }, digest: 'd3' });
    await clock.advance(100);
    await reloader.triggerReload();
    expect(readsWhileStopInFlight).toBe(0);
    expect(stop1Calls).toBe(1);

    // Once stop(1) finishes, followLateStop triggers reload and v3 (not stale v2) is started.
    stopInFlightActive = false;
    releaseStop1?.();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(started).toEqual([1, 3]);
    expect(reloader.status()).toMatchObject({ state: 'running', activeDigest: 'd3' });
    expect(stop1Calls).toBe(1);
    await reloader.shutdown();

    // Post-read stopping guard: shutdown during pending source.read() does not validate or start candidate.
    const clock2 = new FakeClock();
    let resolveRead: ((reading: ConfigSourceReading<{ v: number }>) => void) | undefined;
    let readCall = 0;
    let validateCalls = 0;
    const started2: number[] = [];
    const reloader2 = await startConfigReloader({
      source: {
        read():
          | ConfigSourceReading<{ v: number }>
          | Promise<ConfigSourceReading<{ v: number }>> {
          readCall += 1;
          if (readCall === 1) return { state: 'valid', config: { v: 1 }, digest: 'd1' };
          return new Promise<ConfigSourceReading<{ v: number }>>((resolve) => {
            resolveRead = resolve;
          });
        },
      },
      clock: clock2,
      pollIntervalMs: 100,
      validate() {
        validateCalls += 1;
      },
      start(cfg) {
        started2.push(cfg.v);
        return cfg.v;
      },
      stop: () => undefined,
    });
    expect(validateCalls).toBe(1);
    const pendingReload = reloader2.triggerReload();
    await flushMicrotasks();
    const shut = reloader2.shutdown({ gracePeriodMs: 500 });
    resolveRead?.({ state: 'valid', config: { v: 2 }, digest: 'd2' });
    const shutResult = await shut;
    await pendingReload;
    expect(shutResult.outcome).toBe('clean');
    expect(validateCalls).toBe(1);
    expect(started2).toEqual([1]);
  });

  test('missing config clears pending retry so subsequent unchanged polls do not restart the failed config (missing-reading retry reset)', async () => {
    const clock = new FakeClock();
    const queue: ConfigSourceReading<{ v: number }>[] = [
      { state: 'valid', config: { v: 1 }, digest: 'd1' },
      { state: 'valid', config: { v: 2 }, digest: 'd2' },
      { state: 'missing' },
      { state: 'unchanged' },
    ];
    const started: number[] = [];
    let failV2 = true;

    const reloader = await startConfigReloader({
      source: {
        read: () => queue.shift() ?? { state: 'unchanged' },
      },
      clock,
      pollIntervalMs: 100,
      rollbackOnStartFailure: false,
      start(cfg) {
        started.push(cfg.v);
        if (cfg.v === 2 && failV2) throw new Error('v2 boot failed');
        return cfg.v;
      },
      stop: () => undefined,
    });

    await reloader.triggerReload();
    expect(started).toEqual([1, 2]);
    expect(reloader.status()).toMatchObject({ state: 'degraded', hasActiveHandle: false });

    // Source reports missing, then unchanged; even if v2 would now succeed, retry must be cleared.
    failV2 = false;
    await reloader.triggerReload();
    await reloader.triggerReload();
    expect(started).toEqual([1, 2]);
    expect(reloader.status().hasActiveHandle).toBe(false);
    await reloader.shutdown();
  });

  test('invalid source reading clears pending retry so subsequent unchanged polls do not restart the failed config (invalid-reading retry reset)', async () => {
    const clock = new FakeClock();
    const queue: ConfigSourceReading<{ v: number }>[] = [
      { state: 'valid', config: { v: 1 }, digest: 'd1' },
      { state: 'valid', config: { v: 2 }, digest: 'd2' },
      { state: 'invalid', detail: 'malformed JSON', failureKey: 'bad-json' },
      { state: 'unchanged' },
    ];
    const started: number[] = [];
    let failV2 = true;

    const reloader = await startConfigReloader({
      source: {
        read: () => queue.shift() ?? { state: 'unchanged' },
      },
      clock,
      pollIntervalMs: 100,
      rollbackOnStartFailure: false,
      start(cfg) {
        started.push(cfg.v);
        if (cfg.v === 2 && failV2) throw new Error('v2 boot failed');
        return cfg.v;
      },
      stop: () => undefined,
    });

    await reloader.triggerReload();
    expect(started).toEqual([1, 2]);
    expect(reloader.status()).toMatchObject({ state: 'degraded', hasActiveHandle: false });

    failV2 = false;
    await reloader.triggerReload();
    await reloader.triggerReload();
    expect(started).toEqual([1, 2]);
    expect(reloader.status().hasActiveHandle).toBe(false);
    await reloader.shutdown();
  });

  test('failed validate() clears pending retry so subsequent unchanged polls do not restart the failed config (validation-failure retry reset)', async () => {
    const clock = new FakeClock();
    const queue: ConfigSourceReading<{ v: number }>[] = [
      { state: 'valid', config: { v: 1 }, digest: 'd1' },
      { state: 'valid', config: { v: 2 }, digest: 'd2' },
      { state: 'valid', config: { v: -1 }, digest: 'd-invalid' },
      { state: 'unchanged' },
    ];
    const started: number[] = [];
    let failV2 = true;

    const reloader = await startConfigReloader({
      source: {
        read: () => queue.shift() ?? { state: 'unchanged' },
      },
      clock,
      pollIntervalMs: 100,
      rollbackOnStartFailure: false,
      validate(cfg) {
        if (cfg.v < 0) throw new Error('v must be non-negative');
      },
      start(cfg) {
        started.push(cfg.v);
        if (cfg.v === 2 && failV2) throw new Error('v2 boot failed');
        return cfg.v;
      },
      stop: () => undefined,
    });

    await reloader.triggerReload();
    expect(started).toEqual([1, 2]);
    expect(reloader.status()).toMatchObject({ state: 'degraded', hasActiveHandle: false });

    failV2 = false;
    await reloader.triggerReload();
    await reloader.triggerReload();
    expect(started).toEqual([1, 2]);
    expect(reloader.status().hasActiveHandle).toBe(false);
    await reloader.shutdown();
  });

  test('shutdown() never resolves clean while a stop is still hanging when stopTimeoutMs < gracePeriodMs (both applyValidated and startCandidate)', async () => {
    // (a) applyValidated: stop(oldHandle) hangs past stopTimeoutMs (100ms) while shutdown gracePeriodMs is 500ms
    const clockA = new FakeClock();
    let stopCallsA = 0;
    const reloaderA = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockA,
      stopTimeoutMs: 100,
      start: (cfg) => `h${cfg.v}`,
      stop() {
        stopCallsA += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const reloadA = reloaderA.triggerReload();
    await flushMicrotasks();
    let resolvedA = false;
    const shutA = reloaderA.shutdown({ gracePeriodMs: 500 }).then((result) => {
      resolvedA = true;
      return result;
    });
    await clockA.advance(100);
    expect(resolvedA).toBe(false);
    await clockA.advance(400);
    expect(resolvedA).toBe(true);
    expect(await shutA).toMatchObject({
      outcome: 'forced',
      reason: 'deadline',
      durationMs: 500,
    });
    await reloadA;
    expect(stopCallsA).toBe(1);
    expect(clockA.pendingCount()).toBe(0);

    // (a2) Positive control: stop(oldHandle) settles at 200ms (after stopTimeoutMs, before gracePeriodMs) -> clean
    const clockA2 = new FakeClock();
    let releaseStopA2: (() => void) | undefined;
    const reloaderA2 = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockA2,
      stopTimeoutMs: 100,
      start: (cfg) => `h${cfg.v}`,
      stop() {
        return new Promise<void>((resolve) => {
          releaseStopA2 = resolve;
        });
      },
    });
    const reloadA2 = reloaderA2.triggerReload();
    await flushMicrotasks();
    let resolvedA2 = false;
    const shutA2 = reloaderA2.shutdown({ gracePeriodMs: 500 }).then((result) => {
      resolvedA2 = true;
      return result;
    });
    await clockA2.advance(100);
    expect(resolvedA2).toBe(false);
    await clockA2.advance(100);
    releaseStopA2?.();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(resolvedA2).toBe(true);
    expect(await shutA2).toMatchObject({ outcome: 'clean', durationMs: 200 });
    await reloadA2;
    expect(clockA2.pendingCount()).toBe(0);

    // (b) startCandidate: start(v2) resolves while closing, then stop(h2) hangs past stopTimeoutMs (100ms) < gracePeriodMs (500ms)
    const clockB = new FakeClock();
    let resolveStartB: ((handle: string) => void) | undefined;
    let stopBAborted = false;
    const reloaderB = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockB,
      stopTimeoutMs: 100,
      start(cfg) {
        if (cfg.v === 1) return 'h1';
        return new Promise<string>((resolve) => {
          resolveStartB = resolve;
        });
      },
      stop(handle, signal) {
        if (handle === 'h2') {
          return new Promise<void>(() => {
            signal.addEventListener('abort', () => {
              stopBAborted = true;
            });
          });
        }
      },
    });
    const reloadB = reloaderB.triggerReload();
    await flushMicrotasks();
    let resolvedB = false;
    const shutB = reloaderB.shutdown({ gracePeriodMs: 500 }).then((result) => {
      resolvedB = true;
      return result;
    });
    await clockB.advance(10);
    resolveStartB?.('h2');
    await flushMicrotasks();
    await clockB.advance(100);
    expect(resolvedB).toBe(false);
    await clockB.advance(390);
    expect(resolvedB).toBe(true);
    expect(stopBAborted).toBe(true);
    expect(await shutB).toMatchObject({
      outcome: 'forced',
      reason: 'deadline',
      durationMs: 500,
    });
    await reloadB;
    expect(clockB.pendingCount()).toBe(0);

    // (b2) Positive control: start(v2) resolves while closing, stop(h2) finishes at 200ms -> clean
    const clockB2 = new FakeClock();
    let resolveStartB2: ((handle: string) => void) | undefined;
    let releaseStopB2: (() => void) | undefined;
    const reloaderB2 = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockB2,
      stopTimeoutMs: 100,
      start(cfg) {
        if (cfg.v === 1) return 'h1';
        return new Promise<string>((resolve) => {
          resolveStartB2 = resolve;
        });
      },
      stop(handle) {
        if (handle === 'h2') {
          return new Promise<void>((resolve) => {
            releaseStopB2 = resolve;
          });
        }
      },
    });
    const reloadB2 = reloaderB2.triggerReload();
    await flushMicrotasks();
    let resolvedB2 = false;
    const shutB2 = reloaderB2.shutdown({ gracePeriodMs: 500 }).then((result) => {
      resolvedB2 = true;
      return result;
    });
    resolveStartB2?.('h2');
    await flushMicrotasks();
    await clockB2.advance(150);
    expect(resolvedB2).toBe(false);
    await clockB2.advance(50);
    releaseStopB2?.();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(resolvedB2).toBe(true);
    expect(await shutB2).toMatchObject({ outcome: 'clean', durationMs: 200 });
    await reloadB2;
    expect(clockB2.pendingCount()).toBe(0);
  });

  test('shutdown() waits for in-flight start(v2) and stop(h2) when startTimeoutMs < gracePeriodMs instead of returning clean early', async () => {
    // (a) Slow start(v2) outlives startTimeoutMs (50ms) and resolves at 120ms, then stop(h2) resolves at 200ms -> clean
    const clockA = new FakeClock();
    let resolveStartA: ((handle: string) => void) | undefined;
    let releaseStopA: (() => void) | undefined;
    const stoppedA: string[] = [];
    const reloaderA = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockA,
      startTimeoutMs: 50,
      stopTimeoutMs: 50,
      start(cfg) {
        if (cfg.v === 1) return 'h1';
        return new Promise<string>((resolve) => {
          resolveStartA = resolve;
        });
      },
      stop(handle) {
        stoppedA.push(handle);
        if (handle === 'h2') {
          return new Promise<void>((resolve) => {
            releaseStopA = resolve;
          });
        }
      },
    });

    const reloadA = reloaderA.triggerReload();
    await flushMicrotasks();
    expect(stoppedA).toEqual(['h1']);

    let resolvedA = false;
    const shutA = reloaderA.shutdown({ gracePeriodMs: 500 }).then((result) => {
      resolvedA = true;
      return result;
    });

    // startTimeoutMs (50ms) fires: shutdown must NOT resolve clean while start(v2) is still running.
    await clockA.advance(50);
    expect(resolvedA).toBe(false);

    // At 120ms start(v2) resolves with h2 -> stop(h2) starts, shutdown still waits for stop(h2).
    await clockA.advance(70);
    resolveStartA?.('h2');
    await flushMicrotasks();
    expect(stoppedA).toEqual(['h1', 'h2']);
    expect(resolvedA).toBe(false);

    // At 200ms stop(h2) finishes -> shutdown resolves clean and stop(h2) was called exactly once.
    await clockA.advance(80);
    releaseStopA?.();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(resolvedA).toBe(true);
    expect(await shutA).toMatchObject({ outcome: 'clean', durationMs: 200 });
    expect(stoppedA).toEqual(['h1', 'h2']);
    await reloadA;
    expect(clockA.pendingCount()).toBe(0);

    // (b) Hanging start(v2) outlives both startTimeoutMs (50ms) and gracePeriodMs (500ms) -> forced by deadline;
    // resolving even later still stops h2 exactly once with a fresh un-aborted signal.
    const clockB = new FakeClock();
    let resolveStartB: ((handle: string) => void) | undefined;
    const stoppedB: Array<{ handle: string; aborted: boolean }> = [];
    const reloaderB = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockB,
      startTimeoutMs: 50,
      stopTimeoutMs: 100,
      start(cfg) {
        if (cfg.v === 1) return 'h1';
        return new Promise<string>((resolve) => {
          resolveStartB = resolve;
        });
      },
      stop(handle, signal) {
        stoppedB.push({ handle, aborted: signal.aborted });
      },
    });

    const reloadB = reloaderB.triggerReload();
    await flushMicrotasks();
    let resolvedB = false;
    const shutB = reloaderB.shutdown({ gracePeriodMs: 500 }).then((result) => {
      resolvedB = true;
      return result;
    });

    await clockB.advance(50);
    expect(resolvedB).toBe(false);
    await clockB.advance(449);
    expect(resolvedB).toBe(false);
    await clockB.advance(1);
    expect(resolvedB).toBe(true);
    expect(await shutB).toMatchObject({
      outcome: 'forced',
      reason: 'deadline',
      durationMs: 500,
    });
    await reloadB;
    expect(clockB.pendingCount()).toBe(0);

    // Late resolution after forced deadline still stops h2 once with un-aborted signal.
    resolveStartB?.('h2-late');
    await flushMicrotasks();
    expect(stoppedB).toEqual([
      { handle: 'h1', aborted: false },
      { handle: 'h2-late', aborted: false },
    ]);

    // (c) start(v2) resolves synchronously when startTimeoutMs aborts it while closing -> shutdown still waits for stop(h2).
    const clockC = new FakeClock();
    let releaseStopC: (() => void) | undefined;
    const stoppedC: string[] = [];
    const reloaderC = await startConfigReloader({
      source: createScriptedSource<{ v: number }>([
        { state: 'valid', config: { v: 1 }, digest: 'd1' },
        { state: 'valid', config: { v: 2 }, digest: 'd2' },
      ]),
      clock: clockC,
      startTimeoutMs: 50,
      stopTimeoutMs: 50,
      start(cfg, signal) {
        if (cfg.v === 1) return 'h1';
        return new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('h2-on-abort'), { once: true });
        });
      },
      stop(handle) {
        stoppedC.push(handle);
        if (handle === 'h2-on-abort') {
          return new Promise<void>((resolve) => {
            releaseStopC = resolve;
          });
        }
      },
    });
    const reloadC = reloaderC.triggerReload();
    await flushMicrotasks();
    let resolvedC = false;
    const shutC = reloaderC.shutdown({ gracePeriodMs: 500 }).then((result) => {
      resolvedC = true;
      return result;
    });
    await clockC.advance(50);
    expect(stoppedC).toEqual(['h1', 'h2-on-abort']);
    expect(resolvedC).toBe(false);
    await clockC.advance(100);
    releaseStopC?.();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(resolvedC).toBe(true);
    expect(await shutC).toMatchObject({ outcome: 'clean', durationMs: 150 });
    expect(stoppedC).toEqual(['h1', 'h2-on-abort']);
    await reloadC;
    expect(clockC.pendingCount()).toBe(0);
  });
});
