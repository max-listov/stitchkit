/**
 * A watched read: one read per question, however many are asking.
 *
 * The counter is the load-bearing assertion here, so it is exercised in both
 * directions — a counter that can only ever reach one would make "two browsers,
 * one read" true of a hub that never reads at all.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createWatchHub, type WatchSubscriber, watchKey } from '../src/application/watch-hub';
import { defineContract } from '../src/contract';
import { createWatchClient } from '../src/live/watch-client';
import {
  WATCH_CLOSE,
  WATCH_OPEN,
  WATCH_STATE,
  WATCH_VALUE,
  type WatchStateFrame,
  type WatchValueFrame,
} from '../src/live/watch-contract';

const notes = { service: 'notes', action: 'list' } as const;
const folders = { service: 'notes', action: 'folders' } as const;

/** A subscriber that records what it was told. */
function recorder(): WatchSubscriber & {
  values: WatchValueFrame[];
  states: WatchStateFrame[];
} {
  const values: WatchValueFrame[] = [];
  const states: WatchStateFrame[] = [];
  return {
    values,
    states,
    value: (frame) => {
      values.push(frame);
    },
    state: (frame) => {
      states.push(frame);
    },
  };
}

/** Topic subscriptions, as an event bus would provide them. */
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

/** Waits for the hub's read loop to settle rather than guessing a sleep length. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await Bun.sleep(2);
}

describe('one read per question', () => {
  test('two subscribers to the same question cause one read', async () => {
    let reads = 0;
    const bus = topics();
    const hub = createWatchHub({
      read: async () => ({ notes: ++reads }),
      watchable: () => true,
      invalidatedBy: () => ['notes.changed'],
      subscribe: bus.subscribe,
    });
    const key = await watchKey(notes, { folder: 'a' });

    const first = recorder();
    const second = recorder();
    hub.attach(first).open(key, { folder: 'a' });
    hub.attach(second).open(key, { folder: 'a' });
    await settle();

    expect(hub.readCount()).toBe(1);
    expect(first.values.at(-1)?.value).toEqual({ notes: 1 });
    expect(second.values.at(-1)?.value).toEqual({ notes: 1 });
  });

  test('two different questions cause two reads', async () => {
    // The negative control for the counter. Without it, a hub that never read
    // would pass the test above.
    let reads = 0;
    const bus = topics();
    const hub = createWatchHub({
      read: async () => ({ n: ++reads }),
      watchable: () => true,
      invalidatedBy: () => [],
      subscribe: bus.subscribe,
    });
    const watcher = hub.attach(recorder());
    watcher.open(await watchKey(notes, { folder: 'a' }), { folder: 'a' });
    watcher.open(await watchKey(notes, { folder: 'b' }), { folder: 'b' });
    await settle();
    expect(hub.readCount()).toBe(2);
  });

  test('the same arguments in a different order are the same question', async () => {
    const first = await watchKey(notes, { a: 1, b: 2 });
    const second = await watchKey(notes, { b: 2, a: 1 });
    expect(second.digest).toBe(first.digest);
    // …and different arguments are not.
    expect((await watchKey(notes, { a: 2, b: 1 })).digest).not.toBe(first.digest);
  });
});

describe('what causes a re-read', () => {
  test('a declared topic re-reads; another topic does not', async () => {
    let reads = 0;
    const bus = topics();
    const hub = createWatchHub({
      read: async () => ({ n: ++reads }),
      watchable: () => true,
      invalidatedBy: () => ['notes.changed'],
      subscribe: bus.subscribe,
    });
    hub.attach(recorder()).open(await watchKey(notes, {}), {});
    await settle();
    expect(hub.readCount()).toBe(1);

    bus.announce('folders.changed');
    await settle();
    expect(hub.readCount()).toBe(1);

    bus.announce('notes.changed');
    await settle();
    expect(hub.readCount()).toBe(2);
  });

  test('a topic may be narrowed to the arguments, and then one change wakes one watcher', async () => {
    // Reported by a consuming project watching twenty conversations: an event for
    // one address re-read all twenty, because the topics were derived from the
    // operation alone. Nineteen published nothing — and paid for the read anyway.
    let reads = 0;
    const bus = topics();
    const hub = createWatchHub({
      read: async (_operation, args) => ({ address: (args as { address: string }).address }),
      watchable: () => true,
      invalidatedBy: (_operation, args) => [
        `chat.transcript:${(args as { address: string }).address}`,
      ],
      subscribe: bus.subscribe,
    });
    const watcher = hub.attach(recorder());
    const chat = { service: 'chat', action: 'transcript' } as const;
    watcher.open(await watchKey(chat, { address: 'A' }), { address: 'A' });
    watcher.open(await watchKey(chat, { address: 'B' }), { address: 'B' });
    await settle();
    reads = hub.readCount();
    expect(reads).toBe(2);

    bus.announce('chat.transcript:A');
    await settle();
    // One, not two. Before the fix this was two, and at twenty addresses twenty.
    expect(hub.readCount()).toBe(reads + 1);

    // And the negative control the count needs: the other address still works.
    bus.announce('chat.transcript:B');
    await settle();
    expect(hub.readCount()).toBe(reads + 2);
  });

  test('only a changed answer is published', async () => {
    const bus = topics();
    const hub = createWatchHub({
      read: async () => ({ same: true }),
      watchable: () => true,
      invalidatedBy: () => ['notes.changed'],
      subscribe: bus.subscribe,
    });
    const subscriber = recorder();
    hub.attach(subscriber).open(await watchKey(notes, {}), {});
    await settle();
    bus.announce('notes.changed');
    await settle();
    expect(hub.readCount()).toBe(2);
    expect(subscriber.values).toHaveLength(1);
  });

  test('an invalidation during a read causes exactly one more, and the later answer wins', async () => {
    // The race a hub without single-flight loses: two overlapping reads finish
    // in either order, and the slow one carries the older world. Published in
    // that order it leaves the OLD value standing as current, state `live`,
    // value plausible, nothing to alert anyone.
    const gates: (() => void)[] = [];
    const answers = ['first', 'second', 'third'];
    const bus = topics();
    let started = 0;
    const hub = createWatchHub({
      read: async () => {
        const index = started++;
        await new Promise<void>((resolve) => gates.push(resolve));
        return answers[index];
      },
      watchable: () => true,
      invalidatedBy: () => ['notes.changed'],
      subscribe: bus.subscribe,
    });
    const subscriber = recorder();
    hub.attach(subscriber).open(await watchKey(notes, {}), {});
    await settle();
    expect(started).toBe(1);

    // Two invalidations while the first read is still running.
    bus.announce('notes.changed');
    bus.announce('notes.changed');
    await settle();
    expect(started).toBe(1);

    gates[0]?.();
    await settle();
    // Exactly one more read, not two: the dirty bit coalesces.
    expect(started).toBe(2);
    gates[1]?.();
    await settle();

    expect(subscriber.values.map((frame) => frame.value)).toEqual(['first', 'second']);
    expect(hub.readCount()).toBe(2);
  });
});

describe('a failed read says what failed, in words', () => {
  test('the failure carries its code and message, and a later success clears it', async () => {
    let attempt = 0;
    const bus = topics();
    const hub = createWatchHub({
      read: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw Object.assign(new Error('the database is not accepting connections'), {
            code: 'SERVICE_UNAVAILABLE',
          });
        }
        return { ok: true };
      },
      watchable: () => true,
      invalidatedBy: () => ['notes.changed'],
      subscribe: bus.subscribe,
      backoff: { minDelayMs: 1, maxDelayMs: 2, jitter: 0 },
    });
    const subscriber = recorder();
    hub.attach(subscriber).open(await watchKey(notes, {}), {});
    await settle();

    const failure = subscriber.states.find((state) => state.phase === 'unavailable');
    expect(failure?.code).toBe('SERVICE_UNAVAILABLE');
    expect(failure?.message).toBe('the database is not accepting connections');

    // The retry is the hub's own; nothing outside had to ask for it.
    await Bun.sleep(30);
    expect(subscriber.states.at(-1)?.phase).toBe('live');
    expect(subscriber.values.at(-1)?.value).toEqual({ ok: true });
  });
});

describe('what the hub refuses, and how', () => {
  test('an operation that is not watchable is refused by name', async () => {
    const hub = createWatchHub({
      read: async () => null,
      watchable: (operation) => operation.action !== 'folders',
      invalidatedBy: () => [],
      subscribe: () => () => undefined,
    });
    const watcher = hub.attach(recorder());
    const refusal = watcher.open(await watchKey(folders, {}), {});
    expect(refusal.accepted).toBe(false);
    expect(refusal.reason).toContain('notes.folders is not watchable');
    expect(hub.readCount()).toBe(0);
  });

  test('a connection past its limit is refused, and the refusal says the number', async () => {
    const hub = createWatchHub({
      read: async () => null,
      watchable: () => true,
      invalidatedBy: () => [],
      subscribe: () => () => undefined,
      maxWatchesPerSubscriber: 1,
    });
    const watcher = hub.attach(recorder());
    expect(watcher.open(await watchKey(notes, { n: 1 }), { n: 1 }).accepted).toBe(true);
    const refusal = watcher.open(await watchKey(notes, { n: 2 }), { n: 2 });
    expect(refusal.accepted).toBe(false);
    expect(refusal.reason).toContain('limit 1');
  });
});

describe('a subscriber that arrives late, and one that leaves', () => {
  test('a late subscriber is given the known answer before any read happens', async () => {
    let reads = 0;
    const hub = createWatchHub({
      read: async () => ({ n: ++reads }),
      watchable: () => true,
      invalidatedBy: () => [],
      subscribe: () => () => undefined,
    });
    const key = await watchKey(notes, {});
    hub.attach(recorder()).open(key, {});
    await settle();

    const late = recorder();
    hub.attach(late).open(key, {});
    // Synchronously, with no await between opening and reading the record.
    expect(late.values).toHaveLength(1);
    expect(late.values[0]?.value).toEqual({ n: 1 });
    expect(hub.readCount()).toBe(1);
  });

  test('the last subscriber leaving releases the key', async () => {
    const hub = createWatchHub({
      read: async () => 1,
      watchable: () => true,
      invalidatedBy: () => [],
      subscribe: () => () => undefined,
    });
    const key = await watchKey(notes, {});
    const first = hub.attach(recorder());
    const second = hub.attach(recorder());
    first.open(key, {});
    second.open(key, {});
    await settle();
    expect(hub.size()).toBe(1);

    first.detach();
    expect(hub.size()).toBe(1);
    second.detach();
    await settle();
    expect(hub.size()).toBe(0);
  });
});

describe('the hub options that change what it does', () => {
  test('holdMs keeps a key alive after its last subscriber, and it is reused', async () => {
    let reads = 0;
    const hub = createWatchHub({
      read: async () => ({ n: ++reads }),
      watchable: () => true,
      invalidatedBy: () => [],
      subscribe: () => () => undefined,
      holdMs: 1_000,
    });
    const key = await watchKey(notes, {});
    const first = hub.attach(recorder());
    first.open(key, {});
    await settle();
    first.detach();
    await settle();
    // Still held: the window has not passed.
    expect(hub.size()).toBe(1);

    const late = recorder();
    hub.attach(late).open(key, {});
    expect(hub.readCount()).toBe(1);
    expect(late.values[0]?.value).toEqual({ n: 1 });
  });

  test('a supplied comparator decides what counts as a change', async () => {
    const bus = topics();
    let n = 0;
    const subscriber = recorder();
    const hub = createWatchHub({
      read: async () => ({ n: ++n, at: 'ignored' }),
      watchable: () => true,
      invalidatedBy: () => ['notes.changed'],
      subscribe: bus.subscribe,
      // Only `at` is compared, and it never changes — so nothing is ever
      // republished even though the value does change.
      same: (previous, next) =>
        (previous as { at: string }).at === (next as { at: string }).at,
    });
    hub.attach(subscriber).open(await watchKey(notes, {}), {});
    await settle();
    bus.announce('notes.changed');
    await settle();
    expect(hub.readCount()).toBe(2);
    expect(subscriber.values).toHaveLength(1);
  });

  test('a supplied logger hears about a failed read', async () => {
    const warnings: string[] = [];
    const hub = createWatchHub({
      read: async () => {
        throw new Error('nope');
      },
      watchable: () => true,
      invalidatedBy: () => [],
      subscribe: () => () => undefined,
      backoff: { minDelayMs: 5_000, maxDelayMs: 5_000, jitter: 0 },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string) => void warnings.push(message),
        error: () => undefined,
      },
    });
    hub.attach(recorder()).open(await watchKey(notes, {}), {});
    await settle();
    expect(warnings[0]).toContain('watched read failed');
    hub.close();
  });
});

describe('the client shares one subscription', () => {
  const contract = defineContract(
    { prefix: 'notes' },
    {
      list: { method: 'GET', path: '/', desc: 'List', output: z.object({ n: z.number() }) },
    },
  );

  /** The key the client sent on its `open` — asserted present rather than chained past. */
  function sentKey(sent: { event: string; payload: unknown }[]): unknown {
    const open = sent.find((frame) => frame.event === WATCH_OPEN);
    if (!open) throw new Error('the client never opened a watch');
    return (open.payload as { key: unknown }).key;
  }

  function fakeTransport(options: { connected?: boolean } = {}) {
    const handlers = new Map<string, (payload: never) => void>();
    const connectionListeners = new Set<(connected: boolean, reason?: string) => void>();
    const sent: { event: string; payload: unknown; options?: { timeoutMs: number } }[] = [];
    let connected = options.connected ?? true;
    return {
      sent,
      deliver(event: string, payload: unknown) {
        handlers.get(event)?.(payload as never);
      },
      /** What a socket does when a server restarts, and what it does after. */
      setConnected(next: boolean, reason?: string) {
        connected = next;
        for (const listener of [...connectionListeners]) listener(next, reason);
      },
      transport: {
        on(event: string, handler: (payload: never) => void) {
          handlers.set(event, handler);
          return () => handlers.delete(event);
        },
        emit(event: string, payload: unknown) {
          sent.push({ event, payload });
        },
        async request(event: string, payload: unknown, options: { timeoutMs: number }) {
          if (!connected) {
            throw Object.assign(new Error('socket is not connected'), {
              code: 'REALTIME_DISCONNECTED',
            });
          }
          sent.push({ event, payload, options });
          return { accepted: true };
        },
        onConnectionChange(listener: (connected: boolean, reason?: string) => void) {
          connectionListeners.add(listener);
          return () => connectionListeners.delete(listener);
        },
      },
    };
  }

  test('two subscribers open one watch, and the last one closes it', async () => {
    const fake = fakeTransport();
    const watch = createWatchClient(contract, { transport: fake.transport });

    const handle = watch.list({ folder: 'a' });
    const firstSeen: unknown[] = [];
    const secondSeen: unknown[] = [];
    const dropFirst = handle.subscribe({ value: (v) => firstSeen.push(v) });
    const dropSecond = handle.subscribe({ value: (v) => secondSeen.push(v) });
    await settle();

    expect(fake.sent.filter((frame) => frame.event === WATCH_OPEN)).toHaveLength(1);

    const key = sentKey(fake.sent);
    fake.deliver(WATCH_VALUE, { key, revision: 1, value: { n: 7 } });
    expect(firstSeen).toEqual([{ n: 7 }]);
    expect(secondSeen).toEqual([{ n: 7 }]);

    dropFirst();
    expect(fake.sent.filter((frame) => frame.event === WATCH_CLOSE)).toHaveLength(0);
    dropSecond();
    expect(fake.sent.filter((frame) => frame.event === WATCH_CLOSE)).toHaveLength(1);
  });

  test('openTimeoutMs is the deadline the open acknowledgement is asked for', async () => {
    const fake = fakeTransport();
    const watch = createWatchClient(contract, {
      transport: fake.transport,
      openTimeoutMs: 1_234,
    });
    watch.list({}).subscribe({ value: () => undefined });
    await settle();
    expect(fake.sent[0]?.options).toEqual({ timeoutMs: 1_234 });
  });

  test('a frame no newer than the one held is dropped', async () => {
    const fake = fakeTransport();
    const watch = createWatchClient(contract, { transport: fake.transport });
    const seen: unknown[] = [];
    watch.list({}).subscribe({ value: (v) => seen.push(v) });
    await settle();
    const key = sentKey(fake.sent);

    fake.deliver(WATCH_VALUE, { key, revision: 2, value: 'newer' });
    fake.deliver(WATCH_VALUE, { key, revision: 1, value: 'older' });
    expect(seen).toEqual(['newer']);
  });

  test('a re-subscribe inside the hold window paints from memory, synchronously', async () => {
    const fake = fakeTransport();
    const watch = createWatchClient(contract, { transport: fake.transport, holdMs: 1_000 });
    const drop = watch.list({}).subscribe({ value: () => undefined });
    await settle();
    const key = sentKey(fake.sent);
    fake.deliver(WATCH_VALUE, { key, revision: 1, value: { n: 3 } });
    drop();

    const seen: unknown[] = [];
    // No await between subscribing and asserting: the value must already be there.
    watch.list({}).subscribe({ value: (v) => seen.push(v) });
    expect(seen).toEqual([{ n: 3 }]);
  });

  test('a refusal reaches the subscriber in the words the server used', async () => {
    const handlers = new Map<string, (payload: never) => void>();
    const watch = createWatchClient(contract, {
      transport: {
        on(event: string, handler: (payload: never) => void) {
          handlers.set(event, handler);
          return () => handlers.delete(event);
        },
        emit: () => undefined,
        async request() {
          return { accepted: false, reason: 'notes.list is not watchable' };
        },
        onConnectionChange: () => () => undefined,
      },
    });
    const states: WatchStateFrame[] = [];
    watch.list({}).subscribe({ value: () => undefined, state: (s) => states.push(s) });
    await settle();
    expect(states.at(-1)?.phase).toBe('unavailable');
    expect(states.at(-1)?.message).toBe('notes.list is not watchable');
  });

  test('a drop tells the subscriber, and the next connection re-opens the key', async () => {
    // Measured on a live application restarting its server: every question
    // stayed "open" on the client, the hub remembered none of them, and the face
    // froze without a word. The client holds the keys and the listeners, so it
    // is the only thing that can recover.
    const fake = fakeTransport();
    const watch = createWatchClient(contract, { transport: fake.transport });
    const states: WatchStateFrame[] = [];
    const seen: unknown[] = [];
    watch.list({}).subscribe({ value: (v) => seen.push(v), state: (s) => states.push(s) });
    await settle();
    expect(fake.sent.filter((frame) => frame.event === WATCH_OPEN)).toHaveLength(1);

    fake.setConnected(false, 'transport close');
    expect(states.at(-1)?.phase).toBe('unavailable');
    expect(states.at(-1)?.reason).toBe('source-unavailable');

    fake.setConnected(true);
    await settle();
    // The same key, opened again — not a new question, and not silence.
    const opens = fake.sent.filter((frame) => frame.event === WATCH_OPEN);
    expect(opens).toHaveLength(2);
    expect(opens[1]?.payload).toEqual(opens[0]?.payload);

    const key = sentKey(fake.sent);
    fake.deliver(WATCH_VALUE, { key, revision: 1, value: { n: 5 } });
    expect(seen).toEqual([{ n: 5 }]);
  });

  test('opening over a broken socket is a state, never an unhandled rejection', async () => {
    // The reported symptom was an unhandled rejection in the console and nothing
    // at all for the subscriber — the one outcome that says least.
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    try {
      const fake = fakeTransport({ connected: false });
      const watch = createWatchClient(contract, { transport: fake.transport });
      const states: WatchStateFrame[] = [];
      watch.list({}).subscribe({ value: () => undefined, state: (s) => states.push(s) });
      await settle();
      await Bun.sleep(10);

      // Narrowed to *this* rejection on purpose. A bare toEqual([]) would also fail
      // on a stray promise from any other test in the process — a red that has
      // nothing to do with the thing under test teaches people to ignore red.
      expect(
        rejections.map(String).filter((text) => text.includes('socket is not connected')),
      ).toEqual([]);
      expect(states.at(-1)?.phase).toBe('unavailable');
      expect(states.at(-1)?.code).toBe('REALTIME_DISCONNECTED');
      expect(states.at(-1)?.message).toBe('socket is not connected');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('a failed open is retried by the next connection', async () => {
    const fake = fakeTransport({ connected: false });
    const watch = createWatchClient(contract, { transport: fake.transport });
    watch.list({}).subscribe({ value: () => undefined });
    await settle();
    expect(fake.sent.filter((frame) => frame.event === WATCH_OPEN)).toHaveLength(0);

    fake.setConnected(true);
    await settle();
    expect(fake.sent.filter((frame) => frame.event === WATCH_OPEN)).toHaveLength(1);
  });

  test('two handles on one question open it once', async () => {
    const fake = fakeTransport();
    const watch = createWatchClient(contract, { transport: fake.transport });
    watch.list({ folder: 'a' }).subscribe({ value: () => undefined });
    await settle();
    watch.list({ folder: 'a' }).subscribe({ value: () => undefined });
    await settle();
    expect(fake.sent.filter((frame) => frame.event === WATCH_OPEN)).toHaveLength(1);
  });

  test('the state channel reaches the subscriber', async () => {
    const fake = fakeTransport();
    const watch = createWatchClient(contract, { transport: fake.transport });
    const states: WatchStateFrame[] = [];
    watch.list({}).subscribe({ value: () => undefined, state: (s) => states.push(s) });
    await settle();
    const key = sentKey(fake.sent);
    fake.deliver(WATCH_STATE, {
      key,
      phase: 'unavailable',
      reason: 'source-error',
      code: 'X',
    });
    expect(states.at(-1)?.code).toBe('X');
  });
});
