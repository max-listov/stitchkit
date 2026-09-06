/**
 * The client against a fake host: no DOM, every clock and event injected.
 * The scenarios are the four consumer scars, each as the test that reddens
 * when the mechanism is put back the way it was.
 */
import { describe, expect, test } from 'bun:test';
import type { ClickTarget } from '../src/tracking/clicks';
import {
  CONVENTIONAL_TRACKING_EVENT_TYPES,
  createTrackingClient,
  type TrackingClientConfig,
} from '../src/tracking/client';
import type { TrackingHost } from '../src/tracking/host';
import { createTrackingOutbox, type TrackingOutbox } from '../src/tracking/outbox';
import { memoryOutboxStorage } from '../src/tracking/outbox-storage-memory';
import type {
  TrackEventsRequest,
  TrackingEventEnvelope,
  VisitEntryContext,
} from '../src/tracking/schemas';

interface Metadata {
  PAGE_VIEW: { title: string };
  PAGE_LEAVE: { activeDurationMs: number };
  SCROLL_DEPTH: { maxPercent: number };
  SESSION_HEARTBEAT: { isVisible: boolean };
  CLICK: { element: string };
  OUTBOUND_CLICK: { href: string };
  INTERACTION: { action: string };
  SIGN_OUT: undefined;
}
type Event = TrackingEventEnvelope<keyof Metadata & string>;

function fakeHost() {
  const listeners = new Map<string, Array<() => void>>();
  const clickListeners: Array<(target: ClickTarget | null) => void> = [];
  const timers: Array<{ handler: () => void; ms: number }> = [];
  let monotonic = 0;
  let wall = 1_000_000;
  let uuid = 0;
  let visible = true;
  let scroll = 0;
  const page = {
    pathname: '/',
    search: '',
    origin: 'https://app.example.com',
    hostname: 'app.example.com',
    title: 'Home',
    referrer: 'https://t.me/x',
    viewportWidth: 800,
    viewportHeight: 600,
    screenWidth: 1_000,
    screenHeight: 700,
    displayMode: 'browser' as const,
  };
  const storage = new Map<string, string>();
  const host: TrackingHost = {
    page: () => ({ ...page }),
    visible: () => visible,
    scrollDepth: () => scroll,
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => void list.splice(list.indexOf(handler), 1);
    },
    onClick(handler) {
      clickListeners.push(handler);
      return () => void clickListeners.splice(clickListeners.indexOf(handler), 1);
    },
    interval(handler, ms) {
      const timer = { handler, ms };
      timers.push(timer);
      return () => void timers.splice(timers.indexOf(timer), 1);
    },
    now: () => monotonic,
    wallClock: () => wall,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
  };
  return {
    host,
    page,
    fire: (event: string) => {
      for (const handler of listeners.get(event) ?? []) handler();
    },
    click: (target: ClickTarget | null) => {
      for (const handler of clickListeners) handler(target);
    },
    tick: (ms: number) => {
      monotonic += ms;
      wall += ms;
      for (const timer of timers) if (timer.ms === ms) timer.handler();
    },
    advance: (ms: number) => {
      monotonic += ms;
      wall += ms;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    setScroll: (value: number) => {
      scroll = value;
    },
    timers,
  };
}

function harness(overrides: Partial<TrackingClientConfig<Metadata>> = {}) {
  const fake = fakeHost();
  const delivered: TrackEventsRequest<Event>[] = [];
  const beacons: string[] = [];
  const bootstraps: VisitEntryContext[] = [];
  const outbox: TrackingOutbox<Event> = createTrackingOutbox(memoryOutboxStorage<Event>(), {
    now: () => fake.host.wallClock(),
    randomUUID: () => 'lineage-0000-4000-8000-000000000000',
  });
  const client = createTrackingClient<Metadata>({
    host: fake.host,
    buildId: 'abc1234',
    builtin: CONVENTIONAL_TRACKING_EVENT_TYPES,
    bootstrap: async (entry) => {
      bootstraps.push(entry);
      return { visitId: `visit-${bootstraps.length}`, expiresAt: new Date().toISOString() };
    },
    deliver: async (request) => {
      delivered.push(request);
      return {
        accepted: request.events.length,
        dispositions: request.events.map((event) => ({
          eventId: event.eventId,
          status: 'accepted',
        })),
      };
    },
    unload: (request) => {
      beacons.push(JSON.stringify(request));
      return true;
    },
    outbox,
    heartbeatMs: 30_000,
    ...overrides,
  });
  return { ...fake, client, delivered, beacons, bootstraps, outbox };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const eventsOf = (delivered: TrackEventsRequest<Event>[]) =>
  delivered.flatMap((request) => request.events.map((event) => event.type));

describe('bootstrap and pending', () => {
  test('events tracked before the visit exists are held and sent once it does', async () => {
    const h = harness();
    h.client.track('SIGN_OUT');
    expect(h.delivered).toEqual([]);
    h.client.start();
    await settle();
    expect(h.bootstraps).toHaveLength(1);
    expect(h.bootstraps[0]).toMatchObject({
      browserStreamId: 'lineage-0000-4000-8000-000000000000',
      landingPath: '/',
      buildId: 'abc1234',
      outboxState: 'available',
      referrer: 'https://t.me/x',
    });
    expect(eventsOf(h.delivered)).toEqual(['SIGN_OUT']);
    const event = h.delivered[0]?.events[0];
    expect(event).toMatchObject({ visitId: 'visit-1', browserSequence: 1, page: '/' });
    expect(h.client.visitId()).toBe('visit-1');
  });

  test('onVisit hears every issued visit; deliver is the transport', async () => {
    const seen: string[] = [];
    const h = harness({ onVisit: (id) => seen.push(id) });
    h.client.start();
    await settle();
    h.fire('online');
    await settle();
    expect(seen).toEqual(['visit-1', 'visit-2']);
  });
});

describe('navigation', () => {
  test('a new address emits a leave for the old page and a view for the new one', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.client.onNavigate('/', '?utm_source=news');
    h.advance(2_000);
    h.client.onNavigate('/lessons/1', '');
    await settle();
    expect(eventsOf(h.delivered)).toEqual(['PAGE_VIEW', 'PAGE_LEAVE', 'PAGE_VIEW']);
    const leave = h.delivered.flatMap((r) => r.events).find((e) => e.type === 'PAGE_LEAVE');
    expect(leave).toMatchObject({
      page: '/',
      metadata: { activeDurationMs: 2_000, scrollDepthPercent: 0 },
    });
    // The batch carries current-touch UTM.
    expect(h.delivered.at(-1)?.utm?.source).toBe('news');
  });

  test('the same address again is not a new view', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.client.onNavigate('/a', '');
    h.client.onNavigate('/a', '');
    await settle();
    expect(eventsOf(h.delivered)).toEqual(['PAGE_VIEW']);
  });
});

describe('leaving the page', () => {
  test('unload sends a string beacon with an identity it already holds, without awaiting storage, and queues a copy', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.client.onNavigate('/x', '');
    await settle();
    h.advance(1_500);
    h.fire('pagehide');
    // Synchronous: the beacon is out before any await.
    expect(h.beacons).toHaveLength(1);
    const body = JSON.parse(h.beacons[0] ?? '');
    expect(typeof h.beacons[0]).toBe('string');
    expect(body.events[0]).toMatchObject({
      type: 'PAGE_LEAVE',
      page: '/x',
      visitId: 'visit-1',
      metadata: { activeDurationMs: 1_500 },
    });
    expect(typeof body.events[0].browserSequence).toBe('number');
    await settle();
    // The insurance copy is in the outbox for the next flush.
    expect((await h.outbox.readBatch()).map((e) => e.type)).toEqual(['PAGE_LEAVE']);
  });

  test('pagehide and visibilitychange a millisecond apart are one leave; the lease is released', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.fire('pagehide');
    h.setVisible(false);
    h.fire('visibilitychange');
    expect(h.beacons).toHaveLength(1);
    await settle();
    expect(await h.outbox.acquireLease('next-document')).toBe(true);
  });

  test('returning after a long absence renews the visit', async () => {
    const h = harness({ renewAfterHiddenMs: 1_000 });
    h.client.start();
    await settle();
    h.setVisible(false);
    h.fire('visibilitychange');
    h.advance(1_000);
    h.setVisible(true);
    h.fire('visibilitychange');
    await settle();
    expect(h.bootstraps).toHaveLength(2);
    expect(h.bootstraps[1]?.previousVisitId).toBe('visit-1');
  });
});

describe('heartbeat, scroll and clicks', () => {
  test('the heartbeat carries a visible interval or an empty one', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.tick(30_000);
    await settle();
    h.setVisible(false);
    h.tick(30_000);
    await settle();
    const beats = h.delivered
      .flatMap((r) => r.events)
      .filter((e) => e.type === 'SESSION_HEARTBEAT');
    expect(beats.map((e) => e.metadata?.isVisible)).toEqual([true, false]);
    expect(beats[0]?.metadata?.activeDurationMs).toBe(30_000);
    expect(beats[1]?.metadata?.activeDurationMs).toBe(0);
  });

  test('scroll milestones fire once each, from the deepest point', async () => {
    const h = harness();
    h.client.start();
    await settle();
    // The deepest point is what the scroll listener recorded, not where the
    // page happens to be when the two-second check runs.
    h.setScroll(60);
    h.fire('scroll');
    h.setScroll(30);
    h.tick(2_000);
    h.tick(2_000);
    await settle();
    const depths = h.delivered
      .flatMap((r) => r.events)
      .filter((e) => e.type === 'SCROLL_DEPTH');
    expect(depths.map((e) => e.metadata?.maxPercent)).toEqual([25, 50]);
  });

  test('a tracked click is sent; a click that leaves the page goes out as a beacon', async () => {
    const h = harness();
    h.client.start();
    await settle();
    const element = (attributes: Record<string, string>): ClickTarget => ({
      getAttribute: (name) => attributes[name] ?? null,
      textContent: 'Go',
      closest(selector) {
        if (selector === 'a[href]') return 'href' in attributes ? this : null;
        return Object.keys(attributes).some((name) => selector.includes(`[${name}]`))
          ? this
          : null;
      },
    });
    h.click(element({ 'data-track': 'cta' }));
    await settle();
    expect(eventsOf(h.delivered)).toEqual(['CLICK']);
    h.click(element({ 'data-track': 'ext', href: 'https://other.example/' }));
    expect(h.beacons).toHaveLength(2);
    expect(h.beacons.map((b) => JSON.parse(b).events[0].type)).toEqual([
      'CLICK',
      'OUTBOUND_CLICK',
    ]);
  });
});

describe('what the validators asked for', () => {
  test('drafts parked across a failed first bootstrap go out once a later one succeeds', async () => {
    let attempts = 0;
    const h = harness({
      bootstrap: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return { visitId: 'visit-late', expiresAt: new Date().toISOString() };
      },
    });
    h.client.track('SIGN_OUT');
    await settle();
    expect(h.delivered).toEqual([]);
    h.client.track('SIGN_OUT');
    await settle();
    expect(h.client.visitId()).toBe('visit-late');
    expect(eventsOf(h.delivered)).toEqual(['SIGN_OUT', 'SIGN_OUT']);
  });

  test('decorate adds the application’s fields before the outbox, the beacon and deliver see the event', async () => {
    type Decorated = Event & { locale: string };
    const delivered: Decorated[] = [];
    const beacons: Decorated[] = [];
    const fake = fakeHost();
    const outbox = createTrackingOutbox(memoryOutboxStorage<Decorated>());
    const client = createTrackingClient<Metadata, Decorated>({
      host: fake.host,
      buildId: 'abc1234',
      builtin: CONVENTIONAL_TRACKING_EVENT_TYPES,
      bootstrap: async () => ({ visitId: 'visit-1', expiresAt: new Date().toISOString() }),
      decorate: (event) => ({ ...event, locale: 'en' }),
      deliver: async (request) => {
        delivered.push(...request.events);
        return {
          accepted: 1,
          dispositions: request.events.map((e) => ({
            eventId: e.eventId,
            status: 'accepted',
          })),
        };
      },
      unload: (request) => {
        beacons.push(...request.events);
        return true;
      },
      outbox,
    });
    client.start();
    await settle();
    client.track('SIGN_OUT');
    await settle();
    fake.fire('pagehide');
    await settle();
    expect(delivered.map((e) => e.locale)).toEqual(['en']);
    expect(beacons.map((e) => [e.type, e.locale])).toEqual([['PAGE_LEAVE', 'en']]);
    expect((await outbox.readBatch()).map((e) => e.locale)).toEqual(['en']);
  });

  test('batchSize bounds every request, through the outbox and without one', async () => {
    const withOutbox = harness({ batchSize: 2 });
    withOutbox.client.start();
    await settle();
    for (let i = 0; i < 5; i += 1) withOutbox.client.track('SIGN_OUT');
    await settle();
    withOutbox.tick(30_000); // the periodic flush drains what the coalesced flushes left
    await settle();
    expect(withOutbox.delivered.every((r) => r.events.length <= 2)).toBe(true);
    expect(withOutbox.delivered.flatMap((r) => r.events)).toHaveLength(5 + 1); // + the heartbeat

    const direct = harness({ batchSize: 2, outbox: undefined });
    for (let i = 0; i < 5; i += 1) direct.client.track('SIGN_OUT');
    direct.client.start();
    await settle();
    expect(direct.delivered.map((r) => r.events.length)).toEqual([2, 2, 1]);
  });

  test('stop() before the visit arrives keeps parked drafts parked', async () => {
    const gate: { release?: () => void } = {};
    const h = harness({
      bootstrap: () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({ visitId: 'visit-1', expiresAt: new Date().toISOString() });
        }),
    });
    h.client.track('SIGN_OUT');
    const stop = h.client.start();
    stop();
    gate.release?.();
    await settle();
    expect(h.delivered).toEqual([]);
  });

  test('a hidden heartbeat carries no interval fields at all', async () => {
    const h = harness();
    h.client.start();
    await settle();
    h.setVisible(false);
    h.tick(30_000);
    await settle();
    const beat = h.delivered
      .flatMap((r) => r.events)
      .find((e) => e.type === 'SESSION_HEARTBEAT');
    expect(beat?.metadata).toEqual({ isVisible: false, activeDurationMs: 0 });
  });
});

describe('without an outbox', () => {
  test('events go straight to deliver and the bootstrap reports the queue unavailable', async () => {
    const h = harness({ outbox: undefined });
    h.client.start();
    await settle();
    h.client.track('SIGN_OUT');
    await settle();
    expect(h.bootstraps[0]?.outboxState).toBe('unavailable');
    expect(eventsOf(h.delivered)).toEqual(['SIGN_OUT']);
    expect(typeof h.delivered[0]?.events[0]?.browserSequence).toBe('number');
  });
});

describe('stop', () => {
  test('unsubscribes everything the host was given', async () => {
    const h = harness();
    const stop = h.client.start();
    await settle();
    expect(h.timers.length).toBeGreaterThan(0);
    stop();
    expect(h.timers).toEqual([]);
    h.fire('pagehide');
    expect(h.beacons).toEqual([]);
  });

  test('a client without a buildId is refused at construction, not at the first batch', () => {
    // A JavaScript caller can omit what the type requires; every batch would
    // then be refused by the server schema, one at a time.
    expect(() => createTrackingClient({ buildId: '' } as never)).toThrow('requires a buildId');
  });
});
