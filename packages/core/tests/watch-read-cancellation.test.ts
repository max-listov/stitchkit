/**
 * A watched read stops when nobody waits for it.
 *
 * The hub owns the lifetime of a shared read, so it is the only place that can
 * say when the work is no longer wanted: one subscriber leaving says nothing
 * while another still waits, the last one leaving or the hub closing says it
 * all. Each test drives `createWatchHub` through the entrypoint an application
 * imports, with a read the test settles by hand.
 */
import { describe, expect, test } from 'bun:test';
import {
  createWatchHub,
  type WatchHubConfig,
  type WatchReadRequest,
  type WatchSubscriber,
  watchKey,
} from '../src/entrypoints/application';
import type { WatchStateFrame, WatchValueFrame } from '../src/live/watch-contract';

const notes = { service: 'notes', action: 'list' } as const;
const args = { folder: 'inbox' };
const key = watchKey(notes, args);

interface Call {
  readonly request: WatchReadRequest;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * A read settled by the test. `cooperative` rejects as soon as its signal
 * aborts, the way a read that passes the signal on to `fetch` or a driver does;
 * otherwise the read ignores the signal and runs until the test settles it.
 */
function reads(options: { cooperative?: boolean } = {}) {
  const calls: Call[] = [];
  let running = 0;
  let mostAtOnce = 0;
  const read = (request: WatchReadRequest) =>
    new Promise<unknown>((resolve, reject) => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      const done = () => {
        running -= 1;
      };
      calls.push({
        request,
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      if (options.cooperative) {
        request.signal.addEventListener(
          'abort',
          () => {
            done();
            reject(request.signal.reason);
          },
          { once: true },
        );
      }
    });
  return {
    read,
    calls,
    call(index: number): Call {
      const call = calls[index];
      if (!call) throw new Error(`read ${index} was never started (${calls.length} started)`);
      return call;
    },
    mostAtOnce: () => mostAtOnce,
  };
}

function topics() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    subscribe(topic: string, listener: () => void) {
      const set = listeners.get(topic) ?? new Set();
      listeners.set(topic, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    announce(topic: string) {
      for (const listener of listeners.get(topic) ?? []) listener();
    },
  };
}

function recorder(): WatchSubscriber & { values: unknown[]; states: WatchStateFrame[] } {
  const values: unknown[] = [];
  const states: WatchStateFrame[] = [];
  return {
    values,
    states,
    value: (frame: WatchValueFrame) => {
      if (frame.kind === 'full') values.push(frame.value);
    },
    state: (frame) => {
      states.push(frame);
    },
  };
}

function hubWith(
  read: WatchHubConfig['read'],
  bus = topics(),
  extra: Partial<WatchHubConfig> = {},
) {
  return createWatchHub({
    read,
    watchable: () => true,
    invalidatedBy: () => ['notes.changed'],
    subscribe: bus.subscribe,
    ...extra,
  });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await Bun.sleep(2);
}

describe('a shared read lives as long as someone waits for it', () => {
  test('the first of two subscribers leaving keeps the read; the last one aborts it before it settles', async () => {
    const source = reads();
    const bus = topics();
    const hub = hubWith(source.read, bus);
    const a = recorder();
    const b = recorder();
    const first = hub.attach(a);
    const second = hub.attach(b);
    first.open(key, args);
    second.open(key, args);
    await settle();
    expect(source.calls).toHaveLength(1);
    expect(source.call(0).request).toMatchObject({ operation: notes, args });

    first.detach();
    expect(source.call(0).request.signal.aborted).toBeFalse();
    source.call(0).resolve({ n: 1 });
    await settle();
    expect(b.values).toEqual([{ n: 1 }]);
    expect(a.values).toEqual([]);

    bus.announce('notes.changed');
    await settle();
    expect(source.calls).toHaveLength(2);
    second.detach();
    expect(source.call(1).request.signal.aborted).toBeTrue();
    source.call(1).resolve({ n: 2 });
    await settle();
    expect(b.values).toEqual([{ n: 1 }]);
    await Bun.sleep(20);
    expect(hub.size()).toBe(0);
    hub.close();
  });

  test('closing the hub aborts the read in flight and its late answer reaches nobody', async () => {
    const source = reads();
    const hub = hubWith(source.read);
    const a = recorder();
    hub.attach(a).open(key, args);
    await settle();
    hub.close();
    expect(source.call(0).request.signal.aborted).toBeTrue();
    expect(a.states.at(-1)).toMatchObject({
      phase: 'unavailable',
      reason: 'source-unavailable',
    });
    source.call(0).resolve({ late: true });
    await settle();
    expect(a.values).toEqual([]);
  });

  test('a subscriber arriving right after the last one left gets a fresh read, never the abandoned answer', async () => {
    const source = reads();
    const hub = hubWith(source.read);
    const leaver = hub.attach(recorder());
    leaver.open(key, args);
    await settle();
    leaver.detach();
    expect(source.call(0).request.signal.aborted).toBeTrue();

    const returner = recorder();
    hub.attach(returner).open(key, args);
    await settle();
    // The abandoned read still runs, so it is still the only one.
    expect(source.calls).toHaveLength(1);
    source.call(0).resolve({ stale: true });
    await settle();
    expect(returner.values).toEqual([]);
    expect(source.calls).toHaveLength(2);
    expect(source.call(1).request.signal.aborted).toBeFalse();
    source.call(1).resolve({ fresh: true });
    await settle();
    expect(returner.values).toEqual([{ fresh: true }]);
    hub.close();
  });

  test('a read that ignores its signal is never joined by a second read of the same key', async () => {
    const source = reads();
    const hub = hubWith(source.read);
    for (let round = 0; round < 3; round += 1) {
      const watcher = hub.attach(recorder());
      watcher.open(key, args);
      await settle();
      watcher.detach();
    }
    const last = recorder();
    hub.attach(last).open(key, args);
    await settle();
    expect(source.calls).toHaveLength(1);
    source.call(0).resolve({ abandoned: true });
    await settle();
    expect(source.calls).toHaveLength(2);
    expect(source.mostAtOnce()).toBe(1);
    source.call(1).resolve({ wanted: true });
    await settle();
    expect(last.values).toEqual([{ wanted: true }]);
    hub.close();
  });

  test('an invalidation during a read leaves its signal alone and adds exactly one pass', async () => {
    const source = reads();
    const bus = topics();
    const hub = hubWith(source.read, bus);
    const a = recorder();
    hub.attach(a).open(key, args);
    await settle();
    bus.announce('notes.changed');
    bus.announce('notes.changed');
    expect(source.call(0).request.signal.aborted).toBeFalse();
    source.call(0).resolve({ n: 1 });
    await settle();
    expect(source.calls).toHaveLength(2);
    source.call(1).resolve({ n: 2 });
    await settle();
    expect(source.calls).toHaveLength(2);
    expect(a.values).toEqual([{ n: 1 }, { n: 2 }]);
    hub.close();
  });

  test('the revocation of the last subscriber scope aborts the read too', async () => {
    const source = reads();
    const hub = hubWith(source.read);
    const revoke = new AbortController();
    hub.attach(recorder(), { key: 'account-1', signal: revoke.signal }).open(key, args);
    await settle();
    expect(source.call(0).request.scope).toBe('account-1');
    revoke.abort();
    expect(source.call(0).request.signal.aborted).toBeTrue();
    hub.close();
  });
});

describe('cancellation is not a failure', () => {
  test('an aborted read is neither announced, logged nor retried with backoff; a real failure still is', async () => {
    // Not cooperative: the abandoned read rejects only after the next subscriber
    // has arrived, so the rejection lands while someone is watching the key.
    const source = reads();
    const warnings: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => undefined,
    };
    const hub = hubWith(source.read, topics(), {
      logger,
      backoff: { minDelayMs: 60_000, maxDelayMs: 60_000, jitter: 0 },
    });
    const leaver = hub.attach(recorder());
    leaver.open(key, args);
    await settle();
    leaver.detach();
    const returner = recorder();
    hub.attach(returner).open(key, args);
    await settle();
    expect(source.calls).toHaveLength(1);
    source.call(0).reject(source.call(0).request.signal.reason);
    await settle();
    // A backoff of a minute would hold this read back; cancellation does not.
    expect(source.calls).toHaveLength(2);
    expect(returner.states.some((state) => state.phase === 'unavailable')).toBeFalse();
    expect(warnings).toEqual([]);

    source.call(1).reject(new Error('the database is down'));
    await settle();
    expect(returner.states.at(-1)).toMatchObject({
      phase: 'unavailable',
      reason: 'source-error',
    });
    expect(warnings).toEqual(['[stitchkit] watched read failed']);
    hub.close();
  });

  test('a subscriber returning inside the hold window gets the known value and one fresh read', async () => {
    const source = reads({ cooperative: true });
    const bus = topics();
    const hub = hubWith(source.read, bus, { holdMs: 60_000 });
    const leaver = hub.attach(recorder());
    leaver.open(key, args);
    await settle();
    source.call(0).resolve({ n: 1 });
    await settle();
    bus.announce('notes.changed');
    await settle();
    expect(source.calls).toHaveLength(2);
    leaver.detach();
    // The hold keeps the value, not the work.
    expect(source.call(1).request.signal.aborted).toBeTrue();
    await settle();

    const returner = recorder();
    hub.attach(returner).open(key, args);
    await settle();
    expect(returner.values).toEqual([{ n: 1 }]);
    expect(source.calls).toHaveLength(3);
    expect(source.call(2).request.signal.aborted).toBeFalse();
    source.call(2).resolve({ n: 3 });
    await settle();
    expect(returner.values).toEqual([{ n: 1 }, { n: 3 }]);
    hub.close();
  });
});

describe('the pause after a failure belongs to the key', () => {
  const quiet = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  test('a subscriber that leaves and returns waits out the rest of the pause, with the known state at once', async () => {
    const source = reads();
    const hub = hubWith(source.read, topics(), {
      logger: quiet,
      backoff: { minDelayMs: 300, maxDelayMs: 300, jitter: 0 },
    });
    const leaver = hub.attach(recorder());
    leaver.open(key, args);
    await settle();
    const failedAt = performance.now();
    source.call(0).reject(new Error('the database is down'));
    await settle();
    leaver.detach();
    await Bun.sleep(60);

    const returner = recorder();
    hub.attach(returner).open(key, args);
    await settle();
    // Told what is known at once; the source is not asked again before its pause ends.
    expect(returner.states.at(-1)).toMatchObject({
      phase: 'unavailable',
      reason: 'source-error',
    });
    expect(source.calls).toHaveLength(1);
    await Bun.sleep(120);
    expect(source.calls).toHaveLength(1);
    await Bun.sleep(300 - (performance.now() - failedAt) + 60);
    expect(source.calls).toHaveLength(2);
    hub.close();
  });

  test('an abandoned read leaves the failure count alone: the next pause is longer, not the first again', async () => {
    const source = reads();
    const hub = hubWith(source.read, topics(), {
      logger: quiet,
      backoff: { minDelayMs: 40, maxDelayMs: 4_000, jitter: 0 },
    });
    const first = hub.attach(recorder());
    first.open(key, args);
    await settle();
    source.call(0).reject(new Error('down'));
    await Bun.sleep(60);
    // The retry after 40 ms is in flight; its subscriber walks away and it is abandoned.
    expect(source.calls).toHaveLength(2);
    first.detach();
    const second = hub.attach(recorder());
    second.open(key, args);
    source.call(1).reject(source.call(1).request.signal.reason);
    await settle();
    expect(source.calls).toHaveLength(3);
    source.call(2).reject(new Error('still down'));
    // Second counted failure: the pause is 80 ms. A reset count would retry after 40.
    await Bun.sleep(55);
    expect(source.calls).toHaveLength(3);
    await Bun.sleep(60);
    expect(source.calls).toHaveLength(4);
    hub.close();
  });

  test('a deadline belongs to the read: combined with the signal it fails like any failure', async () => {
    const hub = hubWith(
      ({ signal }) =>
        new Promise((_, reject) => {
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(30)]);
          deadline.addEventListener('abort', () => reject(deadline.reason), { once: true });
        }),
      topics(),
      { logger: quiet, backoff: { minDelayMs: 60_000, maxDelayMs: 60_000, jitter: 0 } },
    );
    const watcher = recorder();
    hub.attach(watcher).open(key, args);
    await Bun.sleep(80);
    expect(watcher.states.at(-1)).toMatchObject({
      phase: 'unavailable',
      reason: 'source-error',
    });
    hub.close();
  });
});
