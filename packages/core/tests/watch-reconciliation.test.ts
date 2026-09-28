import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { createWatchHub, watchKey } from '../src/application/watch-hub';
import { createSessionScope } from '../src/browser/session';
import { defineContract } from '../src/contract/define';
import { argumentsDigest } from '../src/internal/stable-digest';
import { createWatchClient, type WatchTransport } from '../src/live/watch-client';
import {
  WATCH_STATE,
  WATCH_VALUE,
  type WatchKey,
  type WatchValueFrame,
} from '../src/live/watch-contract';
import { createCacheBridge } from '../src/react/cache-bridge';
import { deferred, until } from './session-delivery-fixture';

const contract = defineContract(
  { prefix: 'items' },
  { list: { method: 'GET', path: '/', desc: 'List', output: z.array(z.string()) } },
);

function transport() {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const opened: WatchKey[] = [];
  let closes = 0;
  const wire: WatchTransport = {
    on(event, handler) {
      const listeners = handlers.get(event) ?? new Set();
      // A test emitter erases the event↔payload correlation at its boundary.
      const callback = handler as (value: unknown) => void;
      listeners.add(callback);
      handlers.set(event, listeners);
      return () => {
        listeners.delete(callback);
      };
    },
    emit() {
      closes++;
    },
    async request(_, payload) {
      opened.push(payload.key);
      return { accepted: true };
    },
    onConnectionChange() {
      return () => undefined;
    },
  };
  return {
    wire,
    opened,
    closes: () => closes,
    value(key: WatchKey, value: unknown, revision = 1) {
      const frame: WatchValueFrame = {
        key,
        kind: 'full',
        value,
        revision,
        fingerprint: argumentsDigest({ value }),
      };
      for (const handler of handlers.get(WATCH_VALUE) ?? []) handler(frame);
    },
    state(key: WatchKey) {
      for (const handler of handlers.get(WATCH_STATE) ?? [])
        handler({ key, phase: 'unavailable' });
    },
  };
}

test('verified watch scopes isolate identical arguments and revocation fences pending read delivery', async () => {
  const release = deferred<void>();
  const started = deferred<void>();
  let reads = 0;
  const valuesA: unknown[] = [];
  const valuesB: unknown[] = [];
  const hub = createWatchHub({
    async read(_, _args, scope) {
      reads++;
      started.resolve();
      await release.promise;
      return scope;
    },
    watchable: () => true,
    invalidatedBy: () => [],
    subscribe: () => () => undefined,
    maxSources: 2,
    maxSubscribers: 2,
  });
  const a = new AbortController();
  const b = new AbortController();
  const first = hub.attach(
    {
      value: (value) => {
        valuesA.push(value);
      },
      state() {
        /* Fixture intentionally performs no work. */
      },
    },
    { key: 'A:login-1:permissions-2', signal: a.signal },
  );
  const second = hub.attach(
    {
      value: (value) => {
        valuesB.push(value);
      },
      state() {
        /* Fixture intentionally performs no work. */
      },
    },
    { key: 'B:login-2:permissions-1', signal: b.signal },
  );
  const key = watchKey({ service: 'items', action: 'list' }, {});
  try {
    first.open(key, {});
    second.open(key, {});
    await started.promise;
    expect(reads).toBe(2);
    a.abort();
    release.resolve();
    await until(() => valuesB.length === 1);
    expect(valuesA).toHaveLength(0);
    expect(first.open(key, {}).accepted).toBe(false);
    expect(() =>
      hub.attach({
        value() {
          /* Fixture intentionally performs no work. */
        },
        state() {
          /* Fixture intentionally performs no work. */
        },
      }),
    ).not.toThrow();
    // Over capacity the subscriber is refused through `open`, never by a throw
    // that would land in a connection handler.
    const overflow = hub.attach({
      value() {
        /* Fixture intentionally performs no work. */
      },
      state() {
        /* Fixture intentionally performs no work. */
      },
    });
    expect(overflow.open(key, {})).toEqual({
      accepted: false,
      reason: 'Watch subscriber capacity exceeded',
    });
  } finally {
    release.resolve();
    hub.close();
  }
});

test('hub periodic reconciliation repairs a lost hint without reconnect and enforces source capacity', async () => {
  let state = 1;
  const values: unknown[] = [];
  const hub = createWatchHub({
    read: async () => state,
    watchable: () => true,
    invalidatedBy: () => [],
    subscribe: () => () => undefined,
    reconcileIntervalMs: 10,
    maxSources: 1,
  });
  try {
    const watcher = hub.attach({
      value: (frame) => {
        if (frame.kind === 'full') values.push(frame.value);
      },
      state() {
        /* Fixture intentionally performs no work. */
      },
    });
    watcher.open(watchKey({ service: 'items', action: 'list' }, {}), {});
    await until(() => values.includes(1));
    state = 2;
    await until(() => values.includes(2));
    expect(
      watcher.open(watchKey({ service: 'items', action: 'list' }, { other: 1 }), { other: 1 })
        .accepted,
    ).toBe(false);
  } finally {
    hub.close();
  }
});

test('watch lifetime nonce rejects old frames on a reused socket; cache is stale on loss and removed on logout', async () => {
  const scope = createSessionScope<string>();
  const a = scope.replace('A');
  const t = transport();
  const query = new QueryClient();
  const phases: string[] = [];
  const client = createWatchClient(contract, {
    transport: t.wire,
    session: a,
    maxKeys: 1,
    maxListenersPerKey: 1,
  });
  const handle = client.list();
  const bridge = createCacheBridge({
    socket: { on: () => () => undefined },
    handlers: {},
    queryClient: query,
    session: a,
    watched: [
      {
        handle,
        queryKey: ['items', a.id],
        state: (state) => {
          phases.push(state.phase);
        },
      },
    ],
  });
  try {
    bridge.connect();
    const key = t.opened[0];
    if (!key) throw new Error('No watch opened');
    t.value(key, ['a']);
    expect(query.getQueryData<string[]>(['items', a.id])).toEqual(['a']);
    t.state(key);
    expect(query.getQueryState(['items', a.id])?.isInvalidated).toBe(true);
    expect(phases).toContain('unavailable');
    expect(() =>
      handle.subscribe({
        value() {
          /* Fixture intentionally performs no work. */
        },
      }),
    ).toThrow('capacity');
    // A handle takes no key until it subscribes: capacity refuses the
    // subscription, not the handle a render made and may never use.
    const unused = client.list({ another: 1 });
    expect(() =>
      unused.subscribe({
        value() {
          /* Fixture intentionally performs no work. */
        },
      }),
    ).toThrow('capacity');
    const b = scope.replace('B');
    expect(query.getQueryData<string[]>(['items', a.id])).toBeUndefined();
    const next = createWatchClient(contract, { transport: t.wire, session: b });
    const seen: unknown[] = [];
    const off = next.list().subscribe({
      value: (value) => {
        seen.push(value);
      },
    });
    t.value(key, ['old']);
    expect(seen).toHaveLength(0);
    const newKey = t.opened[1];
    if (!newKey) throw new Error('No new watch');
    t.value(newKey, ['b']);
    expect(seen).toEqual([['b']]);
    expect(t.closes()).toBeGreaterThan(0);
    off();
    scope.stop();
  } finally {
    bridge.disconnect();
    scope.stop();
    query.clear();
  }
});

test('an invalidation during the hold window is read for the next subscriber', async () => {
  const listeners = new Set<() => void>();
  let answer = 1;
  let reads = 0;
  const hub = createWatchHub({
    read: async () => {
      reads++;
      return answer;
    },
    watchable: () => true,
    invalidatedBy: () => ['items'],
    subscribe: (_, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    holdMs: 60_000,
  });
  const key = watchKey({ service: 'items', action: 'list' }, {});
  const seen: unknown[] = [];
  const subscriber = {
    value: (frame: WatchValueFrame) => {
      if (frame.kind === 'full') seen.push(frame.value);
    },
    state() {
      /* Fixture intentionally performs no work. */
    },
  };
  try {
    const first = hub.attach(subscriber);
    first.open(key, {});
    await until(() => seen.length === 1);
    first.detach();
    answer = 2;
    for (const listener of listeners) listener();
    const second = hub.attach(subscriber);
    second.open(key, {});
    await until(() => seen.includes(2));
    expect(reads).toBe(2);
  } finally {
    hub.close();
  }
});

test('one scope reads once for every client instance and routes frames by instance', async () => {
  let reads = 0;
  const hub = createWatchHub({
    read: async () => {
      reads++;
      return ['a'];
    },
    watchable: () => true,
    invalidatedBy: () => [],
    subscribe: () => () => undefined,
  });
  const base = watchKey({ service: 'items', action: 'list' }, {});
  const received: { tab: string; instance?: string }[] = [];
  const tab = (name: string, instance: string, scope: string) => {
    const watcher = hub.attach(
      {
        value: (frame) => {
          received.push({ tab: name, instance: frame.key.instance });
        },
        state() {
          /* Fixture intentionally performs no work. */
        },
      },
      { key: scope, signal: new AbortController().signal },
    );
    return watcher.open({ ...base, instance }, {});
  };
  try {
    expect(tab('one', 'tab-1', 'user-a').accepted).toBe(true);
    expect(tab('two', 'tab-2', 'user-a').accepted).toBe(true);
    await until(() => received.length === 2);
    expect(reads).toBe(1);
    expect(received).toEqual(
      expect.arrayContaining([
        { tab: 'one', instance: 'tab-1' },
        { tab: 'two', instance: 'tab-2' },
      ]),
    );
    // A different scope is a different question, whatever the instance.
    expect(tab('three', 'tab-1', 'user-b').accepted).toBe(true);
    await until(() => received.length === 3);
    expect(reads).toBe(2);
  } finally {
    hub.close();
  }
});

test('handles that are never subscribed take no watch key', () => {
  const t = transport();
  const client = createWatchClient(contract, { transport: t.wire, maxKeys: 1 });
  for (let index = 0; index < 5; index++) client.list({ render: index });
  const off = client.list({ used: true }).subscribe({
    value() {
      /* Fixture intentionally performs no work. */
    },
  });
  expect(t.opened).toHaveLength(1);
  off();
});

test('a second instance on one connection starts from the whole value', async () => {
  const hub = createWatchHub({
    read: async () => ['a'],
    watchable: () => true,
    invalidatedBy: () => [],
    subscribe: () => () => undefined,
  });
  const base = watchKey({ service: 'items', action: 'list' }, {});
  const frames: { instance?: string; kind: string }[] = [];
  const watcher = hub.attach(
    {
      value: (frame) => {
        frames.push({ instance: frame.key.instance, kind: frame.kind });
      },
      state() {
        /* Fixture intentionally performs no work. */
      },
    },
    { key: 'user-a', signal: new AbortController().signal },
  );
  try {
    watcher.open({ ...base, instance: 'tab-1' }, {});
    await until(() => frames.length === 1);
    watcher.open({ ...base, instance: 'tab-2' }, {});
    expect(frames).toEqual([
      { instance: 'tab-1', kind: 'full' },
      { instance: 'tab-2', kind: 'full' },
    ]);
  } finally {
    hub.close();
  }
});
