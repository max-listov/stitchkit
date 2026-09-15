/**
 * Differences on a watched read: the saving, the reassembly, and the refusals.
 *
 * The property test is the load-bearing one. Examples prove the cases somebody
 * thought of, and the cases that break a diff are the ones nobody thinks of —
 * an array that shifted by one, a key whose value became `null`, an element that
 * moved from the end to the middle. It was falsified before it was trusted: with
 * the array copy off by one element it fails within the first few hundred pairs.
 */
import { describe, expect, test } from 'bun:test';
import { createWatchHub, type WatchSubscriber, watchKey } from '../src/application/watch-hub';
import { argumentsDigest, stableValue } from '../src/internal/stable-digest';
import type { WatchStateFrame, WatchValueFrame } from '../src/live/watch-contract';
import { apply, deltaWins, diff } from '../src/live/watch-delta';

const notes = { service: 'notes', action: 'list' } as const;

function recorder(): WatchSubscriber & { values: WatchValueFrame[]; held: () => unknown } {
  const values: WatchValueFrame[] = [];
  let held: unknown;
  return {
    values,
    held: () => held,
    value: (frame) => {
      values.push(frame);
      if (frame.kind === 'full') held = frame.value;
      else if (frame.kind === 'delta') held = apply(held, frame.delta);
    },
    state: (_frame: WatchStateFrame) => undefined,
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

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await Bun.sleep(2);
}

const sig = (value: unknown) => JSON.stringify(stableValue(value));

/** A list answer of roughly the size the hub was measured on: ~75 KB. */
function bigList(stamp: string): { items: { id: string; body: string; seen: string }[] } {
  return {
    items: Array.from({ length: 300 }, (_, index) => ({
      id: `note-${index}`,
      body: 'x'.repeat(200),
      seen: index === 7 ? stamp : '2026-09-15T00:00:00.000Z',
    })),
  };
}

describe('a difference carries the news, not the answer', () => {
  test('a 75 KB answer with one field changed crosses as a frame under 1 KB', async () => {
    const bus = topics();
    let stamp = '2026-09-15T01:00:00.000Z';
    const hub = createWatchHub({
      read: async () => bigList(stamp),
      watchable: () => true,
      invalidatedBy: () => ['notes'],
      subscribe: bus.subscribe,
    });
    const subscriber = recorder();
    const watcher = hub.attach(subscriber);
    watcher.open(watchKey(notes, {}), {});
    await settle();

    const first = subscriber.values.at(-1);
    expect(first?.kind).toBe('full');
    // The denominator, asserted rather than assumed: a saving measured against
    // an answer that turned out to be small would prove nothing.
    expect(JSON.stringify(bigList(stamp)).length).toBeGreaterThan(70_000);

    stamp = '2026-09-15T01:00:15.000Z';
    bus.announce('notes');
    await settle();

    const second = subscriber.values.at(-1);
    expect(second?.kind).toBe('delta');
    expect(JSON.stringify(second).length).toBeLessThan(1024);
    expect(sig(subscriber.held())).toBe(sig(bigList(stamp)));
    hub.close();
  });

  test('a subscriber returning with the current answer is told nothing changed', async () => {
    const bus = topics();
    const hub = createWatchHub({
      read: async () => ({ notes: [1, 2, 3] }),
      watchable: () => true,
      invalidatedBy: () => ['notes'],
      subscribe: bus.subscribe,
      // Resuming needs the key to still be there. `holdMs` is what keeps it
      // through a reconnection, and a hub that drops a key the instant its last
      // subscriber leaves has nothing to resume against — asserted below.
      holdMs: 5_000,
    });
    const key = watchKey(notes, {});
    const first = recorder();
    const firstWatcher = hub.attach(first);
    firstWatcher.open(key, {});
    await settle();
    const held = first.values.at(-1);
    expect(held?.kind).toBe('full');
    firstWatcher.detach();

    // The same page, back on a new socket, offering what it still holds.
    const again = recorder();
    const againWatcher = hub.attach(again);
    againWatcher.open(
      key,
      {},
      {
        revision: held?.revision ?? 0,
        fingerprint: held?.fingerprint ?? '',
      },
    );
    await settle();
    expect(again.values.at(-1)?.kind).toBe('unchanged');
    expect(again.values.every((frame) => frame.kind !== 'full')).toBe(true);
    againWatcher.detach();
    hub.close();
  });

  test('a key dropped before the subscriber returns cannot resume, and says so with a value', async () => {
    // The limit, stated as a test so it is not discovered in production: with no
    // hold window and no other subscriber, the last `detach` releases the source
    // and the hub forgets the answer, the revision and the identity with it. A
    // reconnecting page then pays the whole value once. An application that
    // wants reconnections to be cheap sets `holdMs` past its reconnect delay.
    const bus = topics();
    const hub = createWatchHub({
      read: async () => ({ notes: [1, 2, 3] }),
      watchable: () => true,
      invalidatedBy: () => ['notes'],
      subscribe: bus.subscribe,
    });
    const key = watchKey(notes, {});
    const first = recorder();
    const firstWatcher = hub.attach(first);
    firstWatcher.open(key, {});
    await settle();
    const held = first.values.at(-1);
    firstWatcher.detach();
    expect(hub.size()).toBe(0);

    const again = recorder();
    const againWatcher = hub.attach(again);
    againWatcher.open(
      key,
      {},
      {
        revision: held?.revision ?? 0,
        fingerprint: held?.fingerprint ?? '',
      },
    );
    await settle();
    expect(again.values.at(-1)?.kind).toBe('full');
    againWatcher.detach();
    hub.close();
  });

  test('a fingerprint that matches nothing is answered with the whole value', async () => {
    const bus = topics();
    const hub = createWatchHub({
      read: async () => ({ notes: [1] }),
      watchable: () => true,
      invalidatedBy: () => ['notes'],
      subscribe: bus.subscribe,
    });
    const subscriber = recorder();
    const watcher = hub.attach(subscriber);
    // A value from a previous life of this key: a plausible revision, an
    // identity the hub has never held.
    watcher.open(watchKey(notes, {}), {}, { revision: 1, fingerprint: 'f'.repeat(32) });
    await settle();
    expect(subscriber.values.at(-1)?.kind).toBe('full');
    hub.close();
  });

  test('a hub told to keep no history sends values, never differences', async () => {
    const bus = topics();
    let stamp = 'a';
    const hub = createWatchHub({
      read: async () => bigList(stamp),
      watchable: () => true,
      invalidatedBy: () => ['notes'],
      subscribe: bus.subscribe,
      deltaMemoryBytes: 0,
    });
    const subscriber = recorder();
    hub.attach(subscriber).open(watchKey(notes, {}), {});
    await settle();
    stamp = 'b';
    bus.announce('notes');
    await settle();
    expect(subscriber.values.map((frame) => frame.kind)).toEqual(['full', 'full']);
    hub.close();
  });
});

describe('rebuilding is exact', () => {
  test('apply(previous, diff(previous, next)) is next, over random pairs', () => {
    const random = (depth = 0): unknown => {
      const pick = Math.floor(Math.random() * (depth > 2 ? 5 : 8));
      if (pick === 0) return Math.floor(Math.random() * 10);
      if (pick === 1) return Math.random() < 0.5;
      if (pick === 2) return null;
      if (pick === 3) return ['a', 'b', 'c', 'd'][Math.floor(Math.random() * 4)];
      if (pick === 4) return `t${Math.floor(Math.random() * 1000)}`;
      if (pick === 5) {
        return Array.from({ length: Math.floor(Math.random() * 6) }, () => random(depth + 1));
      }
      const object: Record<string, unknown> = {};
      for (const key of ['x', 'y', 'z', 'w'].slice(0, Math.floor(Math.random() * 5))) {
        if (Math.random() < 0.8) object[key] = random(depth + 1);
      }
      return object;
    };

    let differed = 0;
    for (let round = 0; round < 3000; round += 1) {
      const previous = random();
      // Half the pairs are a copy, so "no difference" is exercised as often as a
      // difference: a diff that never returned `undefined` would still pass a
      // test built only from unequal pairs.
      const next = Math.random() < 0.5 ? random() : JSON.parse(JSON.stringify(previous));
      const delta = diff(previous, next);
      if (delta === undefined) {
        expect(sig(previous)).toBe(sig(next));
        continue;
      }
      differed += 1;
      expect(sig(apply(previous, delta))).toBe(sig(next));
    }
    expect(differed).toBeGreaterThan(500);
  });

  test('an array that slid by one element costs one op, not a rewrite', () => {
    const previous = Array.from({ length: 50 }, (_, index) => ({ id: index }));
    const next = [...previous.slice(1), { id: 50 }];
    const delta = diff(previous, next);
    if (delta === undefined) throw new Error('two different arrays produced no difference');
    expect(delta).toEqual({
      t: 'arr',
      ops: [
        { o: 'copy', from: 1, count: 49 },
        { o: 'put', v: { id: 50 } },
      ],
    });
    expect(apply(previous, delta)).toEqual(next);
  });

  test('a wholesale replacement loses the size comparison and is not sent', () => {
    const previous = Array.from({ length: 30 }, (_, index) => ({ id: index }));
    const next = Array.from({ length: 30 }, (_, index) => ({ other: `${index}` }));
    const delta = diff(previous, next);
    if (delta === undefined) throw new Error('two different arrays produced no difference');
    expect(deltaWins(delta, next)).toBe(false);
  });

  test('a difference applied to the wrong base throws rather than inventing an answer', () => {
    const delta = diff([1, 2, 3], [2, 3, 4]);
    if (delta === undefined) throw new Error('two different arrays produced no difference');
    expect(() => apply([1], delta)).toThrow();
  });

  test('the fingerprint is the value, whatever order its keys arrive in', () => {
    expect(argumentsDigest({ value: { a: 1, b: 2 } })).toBe(
      argumentsDigest({ value: { b: 2, a: 1 } }),
    );
  });
});
