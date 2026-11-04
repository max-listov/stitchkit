import { describe, expect, test } from 'bun:test';
import { createHandlerTestClient } from '../src/entrypoints/testing';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { resolveAttribution } from '../src/tracking/attribution';
import {
  CONVENTIONAL_TRACKING_EVENT_TYPES,
  createTrackingClient,
} from '../src/tracking/client';
import { pageViewDraft } from '../src/tracking/client-visit';
import { createTrackingContract } from '../src/tracking/contract';
import type { TrackingHost } from '../src/tracking/host';
import type { VisitEntryContext } from '../src/tracking/schemas';

type Metadata = Record<
  (typeof CONVENTIONAL_TRACKING_EVENT_TYPES)[keyof typeof CONVENTIONAL_TRACKING_EVENT_TYPES],
  unknown
>;

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

interface PageOptions {
  search?: string;
  referrer?: string;
  clickIdParams?: readonly string[];
  withoutStorage?: boolean;
}

function trackingHost(options: PageOptions, held: ReturnType<typeof storage>): TrackingHost {
  return {
    page: () => ({
      pathname: '/catalog',
      search: options.search ?? '',
      referrer: options.referrer ?? '',
      origin: 'https://shop.example',
      title: 'Shop',
      viewportWidth: 800,
      viewportHeight: 600,
      screenWidth: 800,
      screenHeight: 600,
      displayMode: 'browser',
    }),
    visible: () => true,
    scrollDepth: () => 0,
    on: () => () => undefined,
    onClick: () => () => undefined,
    interval: () => () => undefined,
    now: () => 0,
    wallClock: () => 1_000,
    randomUUID: () => crypto.randomUUID(),
    storage: options.withoutStorage ? null : held,
  };
}

async function bootstrap(options: PageOptions) {
  const received: VisitEntryContext[] = [];
  const issued = Promise.withResolvers<void>();
  const held = storage();
  const contract = createTrackingContract({
    scope: 'public',
    eventTypes: [
      CONVENTIONAL_TRACKING_EVENT_TYPES.pageView,
      CONVENTIONAL_TRACKING_EVENT_TYPES.pageLeave,
      CONVENTIONAL_TRACKING_EVENT_TYPES.scrollDepth,
      CONVENTIONAL_TRACKING_EVENT_TYPES.heartbeat,
      CONVENTIONAL_TRACKING_EVENT_TYPES.click,
      CONVENTIONAL_TRACKING_EVENT_TYPES.outboundClick,
      CONVENTIONAL_TRACKING_EVENT_TYPES.interaction,
    ],
  });
  const service = implement(contract, {
    bootstrap: ({ input }) => {
      received.push(input);
      return { visitId: crypto.randomUUID(), expiresAt: new Date().toISOString() };
    },
    track: ({ input }) => ({
      accepted: input.events.length,
      dispositions: input.events.map((event) => ({
        eventId: event.eventId,
        status: 'accepted',
      })),
    }),
  });
  const api = createHandlerTestClient({
    contract,
    handler: createHandler({ services: [service] }),
  });
  const host = trackingHost(options, held);
  const client = createTrackingClient<Metadata>({
    host,
    buildId: 'dev',
    builtin: CONVENTIONAL_TRACKING_EVENT_TYPES,
    clickIdParams: options.clickIdParams,
    bootstrap: (entry) => api.bootstrap(entry),
    deliver: (batch) => api.track(batch),
    onVisit: () => issued.resolve(),
    onFailure: (_what, error) => issued.reject(error),
  });
  const stop = client.start();
  try {
    await issued.promise;
    expect(received).toHaveLength(1);
    return {
      entry: received[0],
      touch: client.attribution(),
      stored: [...held.values.values()],
    };
  } finally {
    stop();
  }
}

describe('raw attribution through client and HTTP bootstrap', () => {
  test('a referrer reaches bootstrap without synthesised campaign tags', async () => {
    const result = await bootstrap({ referrer: 'https://yandex.ru/search' });
    expect(result.entry?.referrer).toBe('https://yandex.ru/search');
    expect(result.entry?.utm).toBeUndefined();
    expect(result.touch?.firstTouch.utm).toBeUndefined();
    expect(result.touch?.currentTouch.referrer).toBe('https://yandex.ru/search');
  });

  test('configured click markers reach bootstrap without their values', async () => {
    const result = await bootstrap({
      search: '?gclid=private-click-value',
      clickIdParams: ['gclid'],
    });
    expect(result.entry?.clickId).toBe('gclid');
    expect(result.entry?.utm).toBeUndefined();
    expect(result.touch?.firstTouch.clickId).toBe('gclid');
    expect(JSON.stringify(result)).not.toContain('private-click-value');
  });

  test('the application selects click marker names and their priority', async () => {
    expect((await bootstrap({ search: '?gclid=value' })).entry?.clickId).toBeUndefined();
    const result = await bootstrap({
      search: '?gclid=value&custom_ad=one&partner_click=two',
      clickIdParams: ['partner_click', 'custom_ad'],
    });
    expect(result.entry?.clickId).toBe('partner_click');
    expect(JSON.stringify(result)).not.toContain('gclid');
  });

  test('real campaign tags keep case, whitespace and fields without a source', async () => {
    const source = await bootstrap({
      search: '?utm_source=NewsLetter&utm_medium=Paid+Social',
    });
    expect(source.entry?.utm).toEqual({ source: 'NewsLetter', medium: 'Paid Social' });
    const medium = await bootstrap({ search: '?utm_medium=+Email+&utm_campaign=Summer' });
    expect(medium.entry?.utm).toEqual({ medium: ' Email ', campaign: 'Summer' });
  });

  test('unavailable browser storage does not discard raw landing facts', async () => {
    const result = await bootstrap({
      search: '?gclid=value&utm_source=Mail',
      referrer: 'https://yandex.ru/search',
      clickIdParams: ['gclid'],
      withoutStorage: true,
    });
    expect(result.entry).toMatchObject({
      clickId: 'gclid',
      referrer: 'https://yandex.ru/search',
      utm: { source: 'Mail' },
    });
    expect(result.stored).toEqual([]);
  });

  test('campaign credentials are masked before first-touch persistence', async () => {
    const result = await bootstrap({ search: '?utm_source=token%3Dcampaign-secret' });
    expect(result.entry?.utm?.source).toContain('[masked]');
    expect(JSON.stringify(result)).not.toContain('campaign-secret');
  });

  test('an empty credential parameter cannot become a click marker through masking', async () => {
    const result = await bootstrap({ search: '?token=', clickIdParams: ['token'] });
    expect(result.entry?.clickId).toBeUndefined();
    expect(result.touch?.currentTouch.clickId).toBeUndefined();
  });
});

test('first-touch storage key, clock and TTL never supply a previous current campaign', () => {
  const held = storage();
  const options = {
    storage: held,
    storageKey: 'custom-touch',
    referrer: '',
    pathname: '/first',
    ttlMs: 100,
  };
  const first = resolveAttribution({ ...options, search: '?utm_source=Mail', now: 10 });
  expect(first.firstTouch.landingPage).toBe('/first');
  expect(held.getItem('tracking.attribution')).toBeNull();
  expect(held.getItem('custom-touch')).toContain('Mail');
  const direct = resolveAttribution({ ...options, pathname: '/direct', search: '', now: 109 });
  expect(direct.firstTouch.utm?.source).toBe('Mail');
  expect(direct.currentTouch).toMatchObject({
    landingPage: '/direct',
    utm: undefined,
    clickId: undefined,
  });
  const expired = resolveAttribution({ ...options, search: '?utm_source=New', now: 111 });
  expect(expired.firstTouch.utm?.source).toBe('New');
});

test('unversioned mixed attribution is discarded before it can become a real UTM', () => {
  const held = storage();
  held.setItem(
    'tracking.attribution',
    JSON.stringify({
      firstTouch: { data: { utm: { source: 'yandex', medium: 'organic' } }, capturedAt: 1 },
      currentTouch: { data: { utm: { source: 'yandex', medium: 'organic' } }, capturedAt: 1 },
    }),
  );
  const result = resolveAttribution({
    search: '',
    referrer: 'https://yandex.ru/search',
    pathname: '/',
    storage: held,
    now: 2,
  });
  expect(result.firstTouch.utm).toBeUndefined();
  expect(result.currentTouch.utm).toBeUndefined();
  expect(held.getItem('tracking.attribution')).not.toContain('organic');
});

test('the attribution resolver masks credentials for direct consumers before storage', () => {
  const held = storage();
  const result = resolveAttribution({
    search:
      '?utm_source=token%3Dsynthetic-campaign-secret&utm_medium=Paid+Social&gclid=click-value',
    referrer: 'https://search.example/?token=synthetic-referrer-secret',
    pathname: '/catalog',
    storage: held,
    clickIdParams: ['gclid'],
  });
  expect(result.currentTouch.utm?.source).toBe('token=[masked]');
  expect(result.currentTouch.utm?.medium).toBe('Paid Social');
  expect(result.currentTouch.referrer).toBe('https://search.example/?token=[masked]');
  expect(result.currentTouch.clickId).toBe('gclid');
  const collected = JSON.stringify({ result, stored: [...held.values.values()] });
  expect(collected).not.toContain('synthetic-campaign-secret');
  expect(collected).not.toContain('synthetic-referrer-secret');
  expect(collected).not.toContain('click-value');
});

test('click marker names reject invalid configuration and ignore empty values', () => {
  const options = {
    search: '?gclid=&gclid=value',
    referrer: '',
    pathname: '/',
    storage: null,
  };
  expect(
    resolveAttribution({ ...options, clickIdParams: ['gclid'] }).currentTouch.clickId,
  ).toBe('gclid');
  expect(
    resolveAttribution({ ...options, search: '?gclid=', clickIdParams: ['gclid'] })
      .currentTouch.clickId,
  ).toBeUndefined();
  expect(() => resolveAttribution({ ...options, clickIdParams: [''] })).toThrow(
    'clickIdParams',
  );
  expect(() => resolveAttribution({ ...options, clickIdParams: ['x'.repeat(201)] })).toThrow(
    'clickIdParams',
  );
});

test('a click value in a same-site referrer reaches neither bootstrap, a page view nor storage', async () => {
  const referrer = 'https://shop.example/?gclid=synthetic-click&fbclid=synthetic-fb&q=lamp';
  const clickIdParams = ['gclid', 'fbclid'];
  const result = await bootstrap({ referrer, clickIdParams });
  expect(result.entry?.referrer).toBe(
    'https://shop.example/?gclid=[masked]&fbclid=[masked]&q=lamp',
  );
  const view = pageViewDraft(
    trackingHost({ referrer }, storage()),
    'PAGE_VIEW',
    '/catalog',
    null,
    clickIdParams,
  );
  const collected = JSON.stringify({ result, view });
  expect(collected).not.toContain('synthetic-click');
  expect(collected).not.toContain('synthetic-fb');
  expect(collected).toContain('q=lamp');
});

test('the landing path is masked before first-touch storage, as bootstrap sends it', () => {
  const held = storage();
  const result = resolveAttribution({
    search: '',
    referrer: '',
    pathname: '/callback;token=synthetic-path-secret',
    storage: held,
  });
  expect(result.currentTouch.landingPage).toBe('/callback;token=[masked]');
  expect([...held.values.values()].join()).not.toContain('synthetic-path-secret');
});

test('a client refuses an invalid click marker list when it is created', () => {
  for (const clickIdParams of [[''], ['x'.repeat(201)]]) {
    expect(() =>
      createTrackingClient<Metadata>({
        host: trackingHost({}, storage()),
        buildId: 'dev',
        builtin: CONVENTIONAL_TRACKING_EVENT_TYPES,
        clickIdParams,
        bootstrap: () => Promise.reject(new Error('not reached')),
        deliver: () => Promise.reject(new Error('not reached')),
      }),
    ).toThrow('clickIdParams');
  }
});

test('a stored first touch is written once, and one captured in the future is not kept', () => {
  const writes: string[] = [];
  const held = storage();
  const counted = {
    ...held,
    setItem: (key: string, value: string) => {
      writes.push(value);
      held.setItem(key, value);
    },
  };
  const options = { referrer: '', pathname: '/', storage: counted, ttlMs: 100 };
  resolveAttribution({ ...options, search: '?utm_source=Mail', now: 10 });
  resolveAttribution({ ...options, search: '', now: 20 });
  resolveAttribution({ ...options, search: '?utm_source=Other', now: 30 });
  expect(writes).toHaveLength(1);

  held.setItem(
    'tracking.attribution',
    JSON.stringify({
      version: 1,
      firstTouch: { data: { utm: { source: 'Future' } }, capturedAt: 10_000 },
    }),
  );
  const result = resolveAttribution({ ...options, search: '?utm_source=Now', now: 50 });
  expect(result.firstTouch.utm?.source).toBe('Now');
});
