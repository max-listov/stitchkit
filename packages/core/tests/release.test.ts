/**
 * A page follows the release it was built for — the marker, the watcher,
 * the three channels between them, and the four ways the copied original
 * went wrong, each as the test that reddens when it is put back.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';
import { createReleaseMarker } from '../src/release/marker';
import { bindReleaseToSocketServer, observeReleaseFromSocket } from '../src/release/socket';
import {
  browserReleaseHost,
  createReleaseWatcher,
  type ReleaseWatcherHost,
} from '../src/release/watcher';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { DEFAULT_CORS_EXPOSE_HEADERS } from '../src/server/middleware/cors';
import { bindReleaseRefreshSignal } from '../src/server/release-signal';

function fakeHost() {
  let hidden = false;
  const visibility: Array<() => void> = [];
  const timers: Array<{ handler: () => void; ms: number }> = [];
  let reloads = 0;
  let remembered: string | null = null;
  const host: ReleaseWatcherHost = {
    remember: (id) => {
      remembered = id;
    },
    recall: () => remembered,
    hidden: () => hidden,
    onVisibilityChange(handler) {
      visibility.push(handler);
      return () => void visibility.splice(visibility.indexOf(handler), 1);
    },
    setTimeout(handler, ms) {
      const timer = { handler, ms };
      timers.push(timer);
      return () => void timers.splice(timers.indexOf(timer), 1);
    },
    reload: () => {
      reloads += 1;
    },
  };
  return {
    host,
    hide() {
      hidden = true;
      for (const handler of [...visibility]) handler();
    },
    fireCap() {
      for (const timer of timers.splice(0)) timer.handler();
    },
    reloads: () => reloads,
    remembered: () => remembered,
    timers,
    visibility,
  };
}

describe('marker', () => {
  test('reads once, refreshes on demand, reports only a change', () => {
    let value: string | null = 'aaa1111';
    const seen: Array<string | null> = [];
    const marker = createReleaseMarker({ read: () => value });
    marker.subscribe((id) => seen.push(id));
    expect(marker.current()).toBe('aaa1111');
    expect(marker.refresh()).toEqual({ changed: false, buildId: 'aaa1111' });
    value = 'bbb2222';
    expect(marker.current()).toBe('aaa1111');
    expect(marker.refresh()).toEqual({ changed: true, buildId: 'bbb2222' });
    expect(seen).toEqual(['bbb2222']);
  });

  test('a read that fails or returns nothing keeps the last known id', () => {
    const errors: unknown[] = [];
    let value: string | null = 'aaa1111';
    let fail = false;
    const marker = createReleaseMarker({
      read: () => {
        if (fail) throw new Error('ENOENT');
        return value;
      },
      onError: (error) => errors.push(error),
    });
    fail = true;
    expect(marker.refresh()).toEqual({ changed: false, buildId: 'aaa1111' });
    fail = false;
    value = '  ';
    expect(marker.refresh()).toEqual({ changed: false, buildId: 'aaa1111' });
    expect(errors).toHaveLength(1);
    // No release at all (a dev server): the marker is silent from the start.
    expect(createReleaseMarker({ read: () => null }).current()).toBeNull();
  });

  test('a value that is not a build id is reported and treated as none', () => {
    const errors: unknown[] = [];
    const marker = createReleaseMarker({
      read: () => 'abc\ndef',
      onError: (error) => errors.push(error),
    });
    expect(marker.current()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('not a build id');
  });

  test('a subscriber that throws is reported and does not starve the next one', () => {
    let value = 'aaa1111';
    const errors: unknown[] = [];
    const heard: string[] = [];
    const marker = createReleaseMarker({ read: () => value, onError: (e) => errors.push(e) });
    marker.subscribe(() => {
      throw new Error('listener');
    });
    marker.subscribe((id) => heard.push(id ?? ''));
    value = 'bbb2222';
    expect(marker.refresh()).toEqual({ changed: true, buildId: 'bbb2222' });
    expect(heard).toEqual(['bbb2222']);
    expect(errors).toHaveLength(1);
  });
});

describe('watcher', () => {
  test('a stale bundle that first hears the new id still reloads', () => {
    // The original adopted the first id it heard as its own. A tab that
    // loaded a cached bundle after the release would never reload.
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'immediate',
      host: fake.host,
    });
    watcher.observe('new0000');
    expect(fake.reloads()).toBe(1);
  });

  test('the same build, no build, and an ignored own id never reload', () => {
    const fake = fakeHost();
    const same = createReleaseWatcher({
      own: 'aaa1111',
      policy: 'immediate',
      host: fake.host,
    });
    same.observe('aaa1111');
    same.observe(null);
    same.observe(undefined);
    same.observe('');
    expect(same.stale()).toBe(false);
    const dev = createReleaseWatcher({ own: 'dev', policy: 'immediate', host: fake.host });
    dev.observe('aaa1111');
    expect(dev.stale()).toBe(false);
    expect(fake.reloads()).toBe(0);
  });

  test('when-hidden waits for the tab to hide, then reloads once', () => {
    const fake = fakeHost();
    const stale: string[] = [];
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'when-hidden',
      host: fake.host,
      onStale: (id) => stale.push(id),
    });
    watcher.observe('new0000');
    watcher.observe('new0001');
    expect(watcher.stale()).toBe(true);
    expect(stale).toEqual(['new0000']);
    expect(fake.reloads()).toBe(0);
    fake.hide();
    expect(fake.reloads()).toBe(1);
    // The cap was disarmed with the reload — the timer is gone, not just inert.
    expect(fake.timers).toEqual([]);
    fake.fireCap();
    expect(fake.reloads()).toBe(1);
  });

  test('when-hidden reloads at once if the tab is already hidden', () => {
    const fake = fakeHost();
    fake.hide();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'when-hidden',
      host: fake.host,
    });
    watcher.observe('new0000');
    expect(fake.reloads()).toBe(1);
  });

  test('when-hidden reloads at the cap even if the tab never hides', () => {
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'when-hidden',
      maxDeferMs: 60_000,
      host: fake.host,
    });
    watcher.observe('new0000');
    expect(fake.timers.map((t) => t.ms)).toEqual([60_000]);
    fake.fireCap();
    expect(fake.reloads()).toBe(1);
    fake.hide();
    expect(fake.reloads()).toBe(1);
  });

  test('on-navigation waits for the next route change, and reloads at the cap otherwise', () => {
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'on-navigation',
      host: fake.host,
    });
    watcher.navigated();
    watcher.observe('new0000');
    expect(fake.reloads()).toBe(0);
    watcher.navigated();
    expect(fake.reloads()).toBe(1);

    const capped = fakeHost();
    const late = createReleaseWatcher({
      own: 'old0000',
      policy: 'on-navigation',
      host: capped.host,
    });
    late.observe('new0000');
    capped.fireCap();
    expect(capped.reloads()).toBe(1);
  });

  test('one reload per id — a server that still names it after the reload is not obeyed again', () => {
    // The marker reads the wrong root, or a cached response carries an old
    // header: reloading would never make this page the named build.
    const fake = fakeHost();
    const first = createReleaseWatcher({
      own: 'old0000',
      policy: 'immediate',
      host: fake.host,
    });
    first.observe('new0000');
    expect(fake.reloads()).toBe(1);
    expect(fake.remembered()).toBe('new0000');
    // The page came back — same bundle, same host memory, same wrong answer.
    const stale: string[] = [];
    const again = createReleaseWatcher({
      own: 'old0000',
      policy: 'immediate',
      host: fake.host,
      onStale: (id) => stale.push(id),
    });
    again.observe('new0000');
    expect(fake.reloads()).toBe(1);
    expect(again.stale()).toBe(true);
    expect(stale).toEqual(['new0000']);
    // A different id is a new release and reloads once more.
    again.observe('new0001');
    expect(fake.reloads()).toBe(1); // already stale for this page — one verdict per page
    const third = createReleaseWatcher({
      own: 'old0000',
      policy: 'immediate',
      host: fake.host,
    });
    third.observe('new0001');
    expect(fake.reloads()).toBe(2);
  });

  test('an empty own id never reloads', () => {
    const fake = fakeHost();
    const watcher = createReleaseWatcher({ own: '', policy: 'immediate', host: fake.host });
    watcher.observe('new0000');
    expect(fake.reloads()).toBe(0);
    expect(watcher.stale()).toBe(false);
  });

  test('a throwing onStale does not stop the policy from arming', () => {
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'when-hidden',
      host: fake.host,
      onStale: () => {
        throw new Error('toast failed');
      },
    });
    watcher.observe('new0000');
    expect(fake.timers).toHaveLength(1);
    fake.hide();
    expect(fake.reloads()).toBe(1);
  });

  test('the browser host can be built where there is no document, and does nothing', () => {
    const host = browserReleaseHost();
    expect(host.hidden()).toBe(false);
    expect(host.recall()).toBeNull();
    host.remember('x');
    host.onVisibilityChange(() => undefined)();
    host.reload();
    const watcher = createReleaseWatcher({ own: 'old0000', policy: 'immediate' });
    watcher.observe('new0000'); // reload is a no-op without a window; no throw
    expect(watcher.stale()).toBe(true);
  });

  test('dispose disarms the cap and the visibility listener', () => {
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'when-hidden',
      host: fake.host,
    });
    watcher.observe('new0000');
    watcher.dispose();
    expect(fake.timers).toEqual([]);
    fake.hide();
    fake.fireCap();
    expect(fake.reloads()).toBe(0);
    expect(fake.visibility).toEqual([]);
    // Observing after dispose is inert.
    watcher.observe('new0001');
    expect(fake.reloads()).toBe(0);
  });
});

describe('socket channel', () => {
  function fakeIo() {
    const connections: Array<(socket: { emit: (e: string, p: unknown) => void }) => void> = [];
    const broadcasts: Array<[string, unknown]> = [];
    return {
      io: {
        on: (_event: 'connection', handler: (typeof connections)[number]) => {
          connections.push(handler);
        },
        emit: (event: string, payload: { buildId: string | null }) => {
          broadcasts.push([event, payload]);
        },
      },
      connect() {
        const sent: Array<[string, unknown]> = [];
        for (const handler of connections) handler({ emit: (e, p) => sent.push([e, p]) });
        return sent;
      },
      broadcasts,
    };
  }

  test('a connection sees a build the broadcast missed', () => {
    // The process was down when the deploy signal came; the marker still
    // holds the old id. The next connection re-reads the file.
    let value = 'old0000';
    const marker = createReleaseMarker({ read: () => value });
    const fake = fakeIo();
    bindReleaseToSocketServer(fake.io, marker);
    value = 'new0000';
    expect(fake.connect()).toEqual([['release', { buildId: 'new0000' }]]);
    // The refresh that the connection triggered also told everyone else.
    expect(fake.broadcasts).toEqual([['release', { buildId: 'new0000' }]]);
  });

  test('a change broadcasts to everyone; no change broadcasts nothing; no release emits nothing', () => {
    let value: string | null = 'aaa1111';
    const marker = createReleaseMarker({ read: () => value });
    const fake = fakeIo();
    const unbind = bindReleaseToSocketServer(fake.io, marker, { event: 'build' });
    marker.refresh();
    expect(fake.broadcasts).toEqual([]);
    value = 'bbb2222';
    marker.refresh();
    expect(fake.broadcasts).toEqual([['build', { buildId: 'bbb2222' }]]);
    unbind();
    value = 'ccc3333';
    marker.refresh();
    expect(fake.broadcasts).toHaveLength(1);

    const silent = createReleaseMarker({ read: () => null });
    const dev = fakeIo();
    bindReleaseToSocketServer(dev.io, silent);
    expect(dev.connect()).toEqual([]);
  });

  test('refreshOnConnection: false answers from the cached id', () => {
    let value = 'old0000';
    const marker = createReleaseMarker({ read: () => value });
    const fake = fakeIo();
    bindReleaseToSocketServer(fake.io, marker, { refreshOnConnection: false });
    value = 'new0000';
    expect(fake.connect()).toEqual([['release', { buildId: 'old0000' }]]);
  });

  test("the client feed unsubscribes through the client's own dialect", () => {
    // The stitchkit client returns the unsubscribe from `on` and has no `off`.
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'immediate',
      host: fake.host,
    });
    const handlers = new Map<string, (payload: { buildId: string | null }) => void>();
    const off = observeReleaseFromSocket(
      {
        on: (event, handler) => {
          handlers.set(event, handler);
          return () => void handlers.delete(event);
        },
      },
      watcher,
    );
    off();
    expect(handlers.size).toBe(0);
  });

  test('the client feed hands the event to the watcher', () => {
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'immediate',
      host: fake.host,
    });
    const handlers = new Map<string, (payload: { buildId: string | null }) => void>();
    const off = observeReleaseFromSocket(
      {
        on: (event, handler) => void handlers.set(event, handler),
        off: (event) => void handlers.delete(event),
      },
      watcher,
    );
    handlers.get('release')?.({ buildId: 'new0000' });
    expect(fake.reloads()).toBe(1);
    off();
    expect(handlers.size).toBe(0);
  });
});

describe('HTTP channel', () => {
  const api = defineContract(
    { prefix: 'api' },
    {
      ping: {
        method: 'GET',
        path: '/ping',
        desc: 'ping',
        output: z.object({ ok: z.boolean() }),
      },
      boom: {
        method: 'GET',
        path: '/boom',
        desc: 'boom',
        output: z.object({ ok: z.boolean() }),
      },
    },
  );
  const handlerWith = (release?: { current(): string | null }) =>
    createHandler({
      services: [
        implement(api, {
          ping: () => ({ ok: true }),
          boom: () => {
            throw new Error('boom');
          },
        }),
      ],
      rawRoutes: [{ method: 'GET', path: '/raw', handler: () => new Response('raw') }],
      ...(release ? { release } : {}),
    });

  test('every response names the current build — success, error, raw route — and none without a marker', async () => {
    const marker = createReleaseMarker({ read: () => 'aaa1111' });
    const handler = handlerWith(marker);
    for (const path of ['/api/ping', '/api/boom', '/raw', '/nowhere']) {
      const response = await handler(new Request(`http://localhost${path}`));
      expect(response.headers.get('x-build-id')).toBe('aaa1111');
    }
    const preflight = await handler(
      new Request('http://localhost/api/ping', { method: 'OPTIONS' }),
    );
    expect(preflight.headers.get('x-build-id')).toBe('aaa1111');
    const silent = handlerWith(createReleaseMarker({ read: () => null }));
    expect(
      (await silent(new Request('http://localhost/api/ping'))).headers.get('x-build-id'),
    ).toBeNull();
    const none = handlerWith();
    expect(
      (await none(new Request('http://localhost/api/ping'))).headers.get('x-build-id'),
    ).toBeNull();
  });

  test('the header is exposed to a cross-origin page by default', () => {
    expect(DEFAULT_CORS_EXPOSE_HEADERS.split(', ')).toContain('X-Build-Id');
  });

  test('a watcher that throws does not fail the request that carried the header', async () => {
    const handler = handlerWith(createReleaseMarker({ read: () => 'new0000' }));
    const http = createHttpClient({
      baseUrl: 'http://localhost',
      fetch: (input, init) => handler(new Request(input, init)),
      release: {
        observe: () => {
          throw new Error('no document');
        },
      },
    });
    await expect(http.get('api/ping')).resolves.toEqual({ ok: true });
  });

  test('the http client feeds the watcher from every response', async () => {
    const marker = createReleaseMarker({ read: () => 'new0000' });
    const handler = handlerWith(marker);
    const fake = fakeHost();
    const watcher = createReleaseWatcher({
      own: 'old0000',
      policy: 'immediate',
      host: fake.host,
    });
    const http = createHttpClient({
      baseUrl: 'http://localhost',
      fetch: (input, init) => handler(new Request(input, init)),
      release: watcher,
    });
    await http.get('api/ping');
    expect(fake.reloads()).toBe(1);
  });
});

describe('deploy signal', () => {
  test('the signal refreshes the marker and reports what changed', () => {
    const listeners = new Map<string, () => void>();
    const source = {
      on: (signal: string, handler: () => void) => void listeners.set(signal, handler),
      off: (signal: string) => void listeners.delete(signal),
    };
    let value = 'aaa1111';
    const marker = createReleaseMarker({ read: () => value });
    const seen: unknown[] = [];
    const unbind = bindReleaseRefreshSignal(marker, {
      source,
      onRefresh: (result) => seen.push(result),
    });
    value = 'bbb2222';
    listeners.get('SIGUSR2')?.();
    expect(seen).toEqual([{ changed: true, buildId: 'bbb2222' }]);
    expect(marker.current()).toBe('bbb2222');
    unbind();
    expect(listeners.size).toBe(0);
  });

  test('a refresh that throws inside the handler is reported, never thrown at the signal', () => {
    const listeners = new Map<string, () => void>();
    const source = {
      on: (signal: string, handler: () => void) => void listeners.set(signal, handler),
      off: (signal: string) => void listeners.delete(signal),
    };
    const errors: unknown[] = [];
    const marker = createReleaseMarker({ read: () => 'aaa1111' });
    bindReleaseRefreshSignal(marker, {
      source,
      onRefresh: () => {
        throw new Error('logger down');
      },
      onError: (error) => errors.push(error),
    });
    expect(() => listeners.get('SIGUSR2')?.()).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
