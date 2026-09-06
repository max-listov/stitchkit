import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiError } from '../src/browser/http';
import { implement } from '../src/server/implement';
import { listToolNames } from '../src/tools/list-names';
import { resolveAttribution } from '../src/tracking/attribution';
import { sendUnloadBeacon } from '../src/tracking/beacon';
import { type ClickTarget, resolveTrackedClick } from '../src/tracking/clicks';
import { createTrackingContract } from '../src/tracking/contract';
import { deliverTrackingBatch } from '../src/tracking/delivery';
import { createOncePerPage } from '../src/tracking/once-per-page';
import { createTrackingSchemas, type TrackingEventEnvelope } from '../src/tracking/schemas';
import { createScrollMilestones, scrollDepthPercent } from '../src/tracking/scroll';
import { createSequenceReserve } from '../src/tracking/sequence-reserve';
import { createVisibleTimeMeter } from '../src/tracking/visible-time';

describe('sequence reserve', () => {
  test('numbers are taken synchronously and refilled below the low-water mark', async () => {
    const calls: number[] = [];
    let next = 1;
    const reserve = createSequenceReserve(
      async (count) => {
        calls.push(count);
        const block = Array.from({ length: count }, () => next++);
        return block;
      },
      { blockSize: 4, lowWater: 2 },
    );
    expect(reserve.take()).toBeNull();
    await reserve.refill();
    expect([reserve.take(), reserve.take()]).toEqual([1, 2]);
    // Two left = below the low-water mark → a refill is in flight.
    expect(reserve.take()).toBe(3);
    await reserve.refill();
    expect(reserve.take()).toBe(4);
    expect(reserve.take()).toBe(5);
    expect(calls).toEqual([4, 4]);
    expect(reserve.shared()).toBe(true);
  });

  test('a failing source switches to a per-tab fallback, once', async () => {
    const failures: unknown[] = [];
    const reserve = createSequenceReserve(() => Promise.reject(new Error('no idb')), {
      blockSize: 2,
      onUnavailable: (error) => failures.push(error),
      fallbackBase: () => 7,
    });
    await reserve.refill();
    expect(reserve.take()).toBe(7_000_001);
    expect(reserve.take()).toBe(7_000_002);
    await reserve.refill();
    expect(reserve.take()).toBe(7_000_003);
    expect(failures).toHaveLength(1);
    expect(reserve.shared()).toBe(false);
  });
});

describe('delivery', () => {
  const failing = (statuses: number[]) => {
    let attempt = 0;
    return async () => {
      const status = statuses[attempt++];
      if (status === undefined || status === 200) return;
      throw new ApiError('SERVER_ERROR', status, 'boom');
    };
  };
  const noWait = () => Promise.resolve();

  test('retries once on a 5xx and on a network failure', async () => {
    expect(
      await deliverTrackingBatch({
        request: failing([503, 200]),
        onFailure: () => undefined,
        wait: noWait,
      }),
    ).toBe('delivered');
    expect(
      await deliverTrackingBatch({
        request: failing([0, 200]),
        onFailure: () => undefined,
        wait: noWait,
      }),
    ).toBe('delivered');
    expect(
      await deliverTrackingBatch({
        request: failing([503, 503]),
        onFailure: () => undefined,
        wait: noWait,
      }),
    ).toBe('failed');
  });

  test('does not retry a 400', async () => {
    const failures: unknown[] = [];
    expect(
      await deliverTrackingBatch({
        request: failing([400, 200]),
        onFailure: (error) => failures.push(error),
        wait: noWait,
      }),
    ).toBe('failed');
    expect(failures).toHaveLength(1);
  });

  test('a 401 asks for recovery; refused recovery is auth-invalidated', async () => {
    expect(
      await deliverTrackingBatch({
        request: failing([401, 200]),
        onFailure: () => undefined,
        onUnauthorized: async () => true,
        wait: noWait,
      }),
    ).toBe('delivered');
    expect(
      await deliverTrackingBatch({
        request: failing([401, 200]),
        onFailure: () => undefined,
        onUnauthorized: async () => false,
        wait: noWait,
      }),
    ).toBe('auth-invalidated');
    // A 403 is the same question — the session may no longer write.
    expect(
      await deliverTrackingBatch({
        request: failing([403, 200]),
        onFailure: () => undefined,
        onUnauthorized: async () => true,
        wait: noWait,
      }),
    ).toBe('delivered');
    // Without a hook a 401 is an ordinary failure.
    expect(
      await deliverTrackingBatch({
        request: failing([401]),
        onFailure: () => undefined,
        wait: noWait,
      }),
    ).toBe('failed');
  });
});

describe('visible time', () => {
  test('intervals are additive and each has its own id', () => {
    let clock = 0;
    let ids = 0;
    const meter = createVisibleTimeMeter({
      now: () => clock,
      wallClock: () => 10_000 + clock,
      randomUUID: () => `i${++ids}`,
    });
    clock = 700;
    expect(meter.cut()).toEqual({
      activeIntervalId: 'i1',
      activeDurationMs: 700,
      intervalStartedAt: 10_000,
    });
    clock = 1_000;
    expect(meter.cut().activeDurationMs).toBe(300);
    clock = 1_500;
    meter.checkpoint();
    clock = 1_600;
    expect(meter.heartbeat(true)).toMatchObject({ activeDurationMs: 100, isVisible: true });
    expect(meter.heartbeat(false)).toEqual({ activeDurationMs: 0, isVisible: false });
  });
});

describe('scroll', () => {
  test('depth is a percentage of the scrollable range', () => {
    expect(scrollDepthPercent({ scrollHeight: 2_000, innerHeight: 1_000, scrollY: 500 })).toBe(
      50,
    );
    expect(scrollDepthPercent({ scrollHeight: 800, innerHeight: 1_000, scrollY: 0 })).toBe(0);
    expect(
      scrollDepthPercent({ scrollHeight: 2_000, innerHeight: 1_000, scrollY: 5_000 }),
    ).toBe(100);
  });

  test('milestones fire once each from the deepest point, and reset per page', () => {
    const milestones = createScrollMilestones([25, 50, 75, 100]);
    expect(milestones.observe(10)).toEqual([]);
    expect(milestones.observe(60)).toEqual([25, 50]);
    expect(milestones.observe(30)).toEqual([]);
    expect(milestones.max()).toBe(60);
    milestones.reset();
    expect(milestones.observe(100)).toEqual([25, 50, 75, 100]);
  });
});

describe('once per page', () => {
  test('the same key on the same page inside the window is one fact', () => {
    let now = 0;
    const once = createOncePerPage({ windowMs: 15_000, now: () => now });
    expect(once.should('lesson:1', '/lessons/1')).toBe(true);
    expect(once.should('lesson:1', '/lessons/1')).toBe(false);
    expect(once.should('lesson:1', '/lessons/2')).toBe(true);
    now = 15_000;
    expect(once.should('lesson:1', '/lessons/1')).toBe(true);
  });
});

describe('attribution', () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  };
  const base = { pathname: '/', hostname: 'app.example.com', referrer: '' };

  test('a UTM in the address writes current-touch and leaves first-touch alone', () => {
    const store = storage();
    const first = resolveAttribution({
      ...base,
      search: '?utm_source=Google&utm_medium=cpc',
      storage: store,
      now: 1,
    });
    expect(first.firstTouch.utm).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: undefined,
      content: undefined,
      term: undefined,
    });
    const second = resolveAttribution({
      ...base,
      search: '?utm_source=newsletter',
      storage: store,
      now: 2,
    });
    expect(second.firstTouch.utm?.source).toBe('google');
    expect(second.currentTouch.utm?.source).toBe('newsletter');
  });

  test('the referrer map is the application’s; without it an external referrer is a referral', () => {
    expect(
      resolveAttribution({
        ...base,
        search: '',
        referrer: 'https://t.me/channel',
        storage: storage(),
      }).firstTouch.utm,
    ).toEqual({ source: 't.me', medium: 'referral' });
    expect(
      resolveAttribution({
        ...base,
        search: '',
        referrer: 'https://t.me/channel',
        storage: storage(),
        referrerMap: [{ pattern: /t\.me/, source: 'telegram', medium: 'social' }],
      }).firstTouch.utm,
    ).toEqual({ source: 'telegram', medium: 'social' });
    // Same host is not a referrer.
    expect(
      resolveAttribution({
        ...base,
        search: '',
        referrer: 'https://app.example.com/x',
        storage: storage(),
      }).firstTouch.utm,
    ).toBeUndefined();
  });

  test('first-touch expires after ttlMs', () => {
    const store = storage();
    resolveAttribution({
      ...base,
      search: '?utm_source=a',
      storage: store,
      now: 0,
      ttlMs: 100,
    });
    expect(
      resolveAttribution({ ...base, search: '', storage: store, now: 50, ttlMs: 100 })
        .firstTouch.utm?.source,
    ).toBe('a');
    expect(
      resolveAttribution({ ...base, search: '', storage: store, now: 101, ttlMs: 100 })
        .firstTouch.utm,
    ).toBeUndefined();
  });
});

describe('clicks', () => {
  const element = (
    attributes: Record<string, string>,
    text = '',
    parent: ClickTarget | null = null,
  ): ClickTarget => ({
    getAttribute: (name) => attributes[name] ?? null,
    textContent: text,
    closest(selector) {
      const wanted = [...selector.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1] ?? '');
      const isAnchor = selector === 'a[href]';
      const matches = isAnchor
        ? attributes.tag === 'a' && 'href' in attributes
        : wanted.some((name) => name in attributes);
      if (matches) return this;
      return parent?.closest(selector) ?? null;
    },
  });
  const origin = 'https://app.example.com';

  test('an action beats a click; context rides along', () => {
    const target = element(
      {
        'data-track-action': 'lesson_next',
        'data-track-context': 'toc',
        'data-track': 'ignored',
      },
      'Next',
    );
    expect(resolveTrackedClick(target, { origin })).toEqual({
      leavesPage: false,
      interaction: { action: 'lesson_next', context: 'toc' },
    });
  });

  test('an unknown action falls back to the click, when the application says so', () => {
    const target = element({ 'data-track-action': 'nope', 'data-track': 'cta' }, ' Buy now ');
    expect(resolveTrackedClick(target, { origin, isAction: () => false })).toEqual({
      leavesPage: false,
      click: { element: 'cta', elementText: 'Buy now', href: undefined },
    });
  });

  test('a link to another origin is outbound and leaves the page; same-origin only leaves', () => {
    const outbound = element({ tag: 'a', href: 'https://other.example/x?y' }, 'Elsewhere');
    expect(resolveTrackedClick(outbound, { origin })).toEqual({
      leavesPage: true,
      outbound: { href: 'https://other.example/x', label: 'Elsewhere' },
    });
    const inner = element(
      { 'data-track': 'nav' },
      'Docs',
      element({ tag: 'a', href: '/docs' }),
    );
    expect(resolveTrackedClick(inner, { origin })).toEqual({
      leavesPage: true,
      click: { element: 'nav', elementText: 'Docs', href: '/docs' },
    });
  });

  test('attribute names are the application’s; nothing marked is nothing', () => {
    const target = element({ 'data-t': 'x' }, 'X');
    expect(resolveTrackedClick(target, { origin })).toBeNull();
    expect(
      resolveTrackedClick(target, { origin, attributes: { track: 'data-t' } }),
    ).toMatchObject({
      click: { element: 'x' },
    });
    expect(resolveTrackedClick(null, { origin })).toBeNull();
  });
});

describe('beacon', () => {
  test('sends the string body through sendBeacon and reports the absence of the API', () => {
    const sent: Array<[string | URL, BodyInit | null | undefined]> = [];
    const sender = {
      sendBeacon: (url: string | URL, data?: BodyInit | null) => {
        sent.push([url, data]);
        return true;
      },
    };
    expect(sendUnloadBeacon('https://api/track', '{"a":1}', sender)).toBe(true);
    expect(sent).toEqual([['https://api/track', '{"a":1}']]);
    expect(typeof sent[0]?.[1]).toBe('string');
    expect(sendUnloadBeacon('https://api/track', '{}', undefined)).toBe(false);
  });
});

/**
 * `TrackingEventEnvelope` is written out (see the type's comment); this holds
 * it equal to what the schema infers, in both directions, so it cannot drift.
 */
type Inferred = z.infer<
  ReturnType<typeof createTrackingSchemas<'PAGE_VIEW' | 'CLICK'>>['event']
>;
type Declared = TrackingEventEnvelope<'PAGE_VIEW' | 'CLICK'>;
const inferredIsDeclared: Declared = {} as Inferred;
const declaredIsInferred: Inferred = {} as Declared;
void [inferredIsDeclared, declaredIsInferred];

describe('schemas and contract', () => {
  test('event types and extras shape the envelope; the build id pattern is overridable', () => {
    const schemas = createTrackingSchemas({
      eventTypes: ['PAGE_VIEW', 'CLICK'],
      eventExtras: z.object({ locale: z.string() }),
      buildIdPattern: /^build-\d+$/,
      maxEventsPerBatch: 2,
    });
    const event = {
      eventId: crypto.randomUUID(),
      visitId: crypto.randomUUID(),
      browserStreamId: crypto.randomUUID(),
      browserSequence: 1,
      type: 'PAGE_VIEW',
      page: '/',
      clientTimestamp: 1,
      locale: 'en',
    };
    expect(schemas.event.safeParse(event).success).toBe(true);
    expect(schemas.event.safeParse({ ...event, type: 'SIGN_OUT' }).success).toBe(false);
    expect(schemas.event.safeParse({ ...event, locale: undefined }).success).toBe(false);
    expect(schemas.request.safeParse({ buildId: 'build-7', events: [event] }).success).toBe(
      true,
    );
    expect(schemas.request.safeParse({ buildId: 'abc1234', events: [event] }).success).toBe(
      false,
    );
    expect(
      schemas.request.safeParse({ buildId: 'build-7', events: [event, event, event] }).success,
    ).toBe(false);
    // Without extras the plain envelope is enough.
    const plain = createTrackingSchemas({ eventTypes: ['PAGE_VIEW'] });
    expect(plain.event.safeParse({ ...event, locale: undefined }).success).toBe(true);
  });

  test('the contract has the two operations and track is safelisted', () => {
    const contract = createTrackingContract({ scope: 'public', eventTypes: ['PAGE_VIEW'] });
    expect(contract.meta).toEqual({ prefix: 'tracking', scope: 'public' });
    expect(contract.endpoints.bootstrap.path).toBe('/visit');
    expect(contract.endpoints.track.path).toBe('/events');
    expect(contract.endpoints.track.safelistedBody).toBe(true);
    expect(contract.endpoints.track.maxJsonBodyBytes).toBe(256 * 1024);
  });

  /**
   * Asked of the mounted surface rather than of the field, because the field is
   * not what does the harm. An endpoint with no `expose` is a tool on MCP and
   * AGENT by default, and this contract is built inside the framework — so an
   * application that made every tool opt-in for the endpoints it authors was
   * still given a `track` tool, and an agent could write into its visitor data
   * under its own name. `bootstrap` carried `['HTTP']`; `track` did not, and
   * nothing said so until a consumer's tool-surface digest moved by one.
   */
  test('neither tracking operation is a tool on any transport', () => {
    const contract = createTrackingContract({ scope: 'public', eventTypes: ['PAGE_VIEW'] });
    const service = implement(contract, {
      bootstrap: () => {
        throw new Error('not called');
      },
      track: () => {
        throw new Error('not called');
      },
    });
    expect(listToolNames({ services: [service] })).toEqual([]);
    expect(contract.endpoints.bootstrap.expose).toEqual(['HTTP']);
    expect(contract.endpoints.track.expose).toEqual(['HTTP']);
  });
});
