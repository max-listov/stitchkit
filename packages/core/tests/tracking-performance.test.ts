import { afterEach, describe, expect, test } from 'bun:test';
import {
  redactTrackingText,
  redactTrackingValue,
  resolveAttribution,
} from '../src/entrypoints/tracking';
import {
  PerformanceSampleSchema,
  summarizePerformanceMetric,
} from '../src/entrypoints/tracking/contract';
import {
  createPerformanceCollector,
  isLabUserAgent,
  type PerformanceCollector,
  type PerformanceCollectorConfig,
  type PerformanceHost,
  type VitalsLibrary,
  type VitalsMetric,
} from '../src/entrypoints/tracking/performance';
import { trackingTelemetryHealth } from '../src/entrypoints/tracking/server';

const VISITOR = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0 Safari/537.36';

function page(overrides: Partial<PerformanceHost> = {}) {
  const sent: string[] = [];
  const stored = new Map<string, string>();
  const hidden: (() => void)[] = [];
  const timers: (() => void)[] = [];
  let loaded: (() => void) | undefined;
  const host: PerformanceHost = {
    userAgent: VISITOR,
    automated: false,
    mobile: false,
    now: () => 1_000,
    route: () => '/checkout?token=abc&step=2',
    afterLoad: (work) => {
      loaded = work;
    },
    onHidden: (work) => {
      hidden.push(work);
    },
    after: (_delay, work) => {
      timers.push(work);
    },
    beacon: (_url, body) => {
      sent.push(body);
      return true;
    },
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
      removeItem: (key) => void stored.delete(key),
    },
    ...overrides,
  };
  return {
    host,
    sent,
    stored,
    load: () => loaded?.(),
    hide: () => {
      for (const work of hidden) work();
    },
    elapse: () => {
      for (const work of timers.splice(0)) work();
    },
  };
}

function vitals(values: Partial<Record<keyof VitalsLibrary, number>>) {
  const reports = new Map<keyof VitalsLibrary, (metric: VitalsMetric) => void>();
  const observer =
    (name: keyof VitalsLibrary) =>
    (report: (metric: VitalsMetric) => void): void => {
      reports.set(name, report);
      const value = values[name];
      if (value !== undefined) report({ name, value, navigationType: 'navigate' });
    };
  const library: VitalsLibrary = {
    onLCP: observer('onLCP'),
    onINP: observer('onINP'),
    onCLS: observer('onCLS'),
    onFCP: observer('onFCP'),
    onTTFB: observer('onTTFB'),
  };
  return { library, reports };
}

const collectors: PerformanceCollector[] = [];

/** One collector a page: each test stops its own, as a page that goes away would. */
function collect(config: PerformanceCollectorConfig): PerformanceCollector {
  const collector = createPerformanceCollector(config);
  collectors.push(collector);
  return collector;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createPerformanceCollector', () => {
  afterEach(() => {
    for (const collector of collectors.splice(0)) collector.stop();
  });

  test('nothing loads before the page has, and a sample carries all five metrics', async () => {
    const browser = page();
    let loads = 0;
    const { library } = vitals({
      onLCP: 1800,
      onINP: 120,
      onCLS: 0.02,
      onFCP: 900,
      onTTFB: 200,
    });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => {
        loads += 1;
        return library;
      },
    });
    expect(loads).toBe(0);
    browser.load();
    await tick();
    expect(loads).toBe(1);
    browser.elapse();
    const early = PerformanceSampleSchema.parse(JSON.parse(browser.sent[0] ?? ''));
    expect(early).toMatchObject({
      kind: 'early',
      route: '/checkout?token=[masked]&step=2',
      buildId: 'abc1234',
      deviceClass: 'desktop',
      navigationType: 'navigate',
      vitals: { lcpMs: 1800, inpMs: 120, cls: 0.02, fcpMs: 900, ttfbMs: 200 },
    });
  });

  test('a metric that did not arrive is null, not zero', async () => {
    const browser = page();
    const { library } = vitals({ onLCP: 1800 });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => library,
    });
    browser.load();
    await tick();
    browser.hide();
    const sample = PerformanceSampleSchema.parse(JSON.parse(browser.sent[0] ?? ''));
    expect(sample.kind).toBe('final');
    expect(sample.vitals).toEqual({
      lcpMs: 1800,
      inpMs: null,
      fcpMs: null,
      ttfbMs: null,
      cls: null,
    });
  });

  test('the final sample carries what changed after the early one, under one id', async () => {
    const browser = page();
    const { library, reports } = vitals({ onLCP: 1800 });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => library,
    });
    browser.load();
    await tick();
    browser.elapse();
    reports.get('onINP')?.({ name: 'INP', value: 300 });
    browser.hide();
    browser.hide();
    expect(browser.sent).toHaveLength(2);
    const [early, final] = browser.sent.map((body) =>
      PerformanceSampleSchema.parse(JSON.parse(body)),
    );
    expect(final?.vitals.inpMs).toBe(300);
    expect(final?.id).toBe(early?.id ?? '');
  });

  test('a page that measured nothing sends nothing', async () => {
    const browser = page();
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => vitals({}).library,
    });
    browser.load();
    await tick();
    browser.elapse();
    browser.hide();
    expect(browser.sent).toEqual([]);
  });

  test('a metric after a back-forward restore does not replace the load', async () => {
    const browser = page();
    const { library, reports } = vitals({ onLCP: 1800, onTTFB: 200, onINP: 232 });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => library,
    });
    browser.load();
    await tick();
    const restored = { navigationType: 'back-forward-cache' };
    reports.get('onINP')?.({ name: 'INP', value: 8, ...restored });
    reports.get('onTTFB')?.({ name: 'TTFB', value: 0, ...restored });
    browser.hide();
    const sample = PerformanceSampleSchema.parse(JSON.parse(browser.sent[0] ?? ''));
    expect(sample.vitals).toMatchObject({ inpMs: 232, ttfbMs: 200 });
    expect(sample.navigationType).toBe('navigate');
  });

  test('a second call on one page returns the running collector', async () => {
    const browser = page();
    const config = {
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => vitals({ onLCP: 1800 }).library,
    };
    expect(collect(config)).toBe(collect(config));
  });

  test('a final sample leaves even when nothing changed, and no early one follows it', async () => {
    const browser = page();
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => vitals({ onLCP: 1800 }).library,
    });
    browser.load();
    await tick();
    browser.hide();
    browser.elapse();
    expect(browser.sent.map((body) => JSON.parse(body).kind)).toEqual(['final']);

    collectors.splice(0).forEach((collector) => {
      collector.stop();
    });
    const again = page();
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: again.host,
      loadVitals: async () => vitals({ onLCP: 1800 }).library,
    });
    again.load();
    await tick();
    again.elapse();
    again.hide();
    expect(again.sent.map((body) => JSON.parse(body).kind)).toEqual(['early', 'final']);
  });

  test('of one load only the newest sample waits', async () => {
    const browser = page({ beacon: () => false });
    const { library, reports } = vitals({ onLCP: 1800 });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => library,
    });
    browser.load();
    await tick();
    browser.elapse();
    reports.get('onINP')?.({ name: 'INP', value: 300 });
    browser.hide();
    const pending: string[] = JSON.parse([...browser.stored.values()][0] ?? '[]');
    expect(pending.map((body) => JSON.parse(body).kind)).toEqual(['final']);
  });

  test('a value past the wire limit is held at it, and the sample survives', async () => {
    const browser = page();
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => vitals({ onLCP: 9_000_000, onCLS: 500 }).library,
    });
    browser.load();
    await tick();
    browser.hide();
    const sample = PerformanceSampleSchema.parse(JSON.parse(browser.sent[0] ?? ''));
    expect(sample.vitals).toMatchObject({ lcpMs: 3_600_000, cls: 100 });
  });

  test('earlyDelayMs is when the early sample leaves, and visitId goes with it', async () => {
    const delays: number[] = [];
    const browser = page({
      after: (delay, work) => {
        delays.push(delay);
        work();
      },
    });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      earlyDelayMs: 1_234,
      visitId: () => 'visit-1',
      loadVitals: async () => vitals({ onLCP: 1800 }).library,
    });
    browser.load();
    await tick();
    expect(delays).toEqual([1_234]);
    expect(PerformanceSampleSchema.parse(JSON.parse(browser.sent[0] ?? '')).visitId).toBe(
      'visit-1',
    );
  });

  test('on a server there is no page, and nothing throws', () => {
    const { document: _absent, ...rest } = globalThis;
    expect(typeof Reflect.get(rest, 'document')).toBe('undefined');
    expect(
      createPerformanceCollector({ buildId: 'abc1234', url: '/rum' }).stop(),
    ).toBeUndefined();
  });

  test('a browser under automation sends nothing, whatever it says it is', async () => {
    const browser = page({ automated: true });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => vitals({ onLCP: 1 }).library,
    });
    browser.load();
    await tick();
    browser.hide();
    expect(browser.sent).toEqual([]);
  });

  test.each([
    'Chrome-Lighthouse',
    'Mozilla/5.0 HeadlessChrome/142.0',
    'GTmetrix',
    'Googlebot/2.1',
  ])('a lab agent gives no sample: %s', async (userAgent) => {
    expect(isLabUserAgent(userAgent)).toBe(true);
    const browser = page({ userAgent });
    let loads = 0;
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => {
        loads += 1;
        return vitals({ onLCP: 1 }).library;
      },
    });
    browser.load();
    await tick();
    browser.hide();
    expect(browser.sent).toEqual([]);
    expect(loads).toBe(0);
  });

  test('a refused beacon waits for the next page, within a bound', async () => {
    let accepting = false;
    const first = page({ beacon: () => accepting });
    const { library } = vitals({ onLCP: 1800 });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: first.host,
      loadVitals: async () => library,
    });
    first.load();
    await tick();
    first.hide();
    expect([...first.stored.keys()]).toHaveLength(1);
    collectors.splice(0).forEach((collector) => {
      collector.stop();
    });

    accepting = true;
    const delivered: string[] = [];
    const next = page({
      storage: first.host.storage,
      beacon: (_url, body) => {
        delivered.push(body);
        return true;
      },
    });
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: next.host,
      loadVitals: async () => vitals({}).library,
    });
    next.load();
    await tick();
    expect(delivered).toHaveLength(1);
    expect(first.stored.size).toBe(0);
  });

  test('a chunk that fails to load costs the measurement, not the page', async () => {
    const browser = page();
    collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => {
        throw new Error('blocked');
      },
    });
    browser.load();
    await tick();
    browser.hide();
    expect(browser.sent).toEqual([]);
  });

  test('a stopped collector sends nothing', async () => {
    const browser = page();
    const collector = collect({
      buildId: 'abc1234',
      url: '/rum',
      host: browser.host,
      loadVitals: async () => vitals({ onLCP: 1 }).library,
    });
    browser.load();
    await tick();
    collector.stop();
    browser.hide();
    expect(browser.sent).toEqual([]);
  });
});

describe('summarizePerformanceMetric', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);

  test('p95 appears at the threshold, and a missing value is not a fast one', () => {
    expect(summarizePerformanceMetric(hundred)).toEqual({ samples: 100, p75: 75, p95: 95 });
    expect(summarizePerformanceMetric(hundred.slice(1))).toMatchObject({
      samples: 99,
      p95: null,
    });
    expect(summarizePerformanceMetric([...hundred, null, null])).toMatchObject({
      samples: 100,
    });
  });

  test('no samples, no figures', () => {
    expect(summarizePerformanceMetric([null])).toEqual({ samples: 0, p75: null, p95: null });
  });
});

describe('redaction', () => {
  test.each([
    ['/a?password=x&utm_source=mail', '/a?password=[masked]&utm_source=mail'],
    ['/a?code=SUMMER', '/a?code=SUMMER'],
    ['/a?code=abc&state=def', '/a?code=[masked]&state=[masked]'],
    ['/a?hash=abc#top', '/a?hash=abc#top'],
    ['/a?hash=abc&auth_date=1', '/a?hash=[masked]&auth_date=1'],
    ['https://user:secret@host.test/', 'https://user:[masked]@host.test/'],
    [
      '/a#tgWebAppData=signed&tgWebAppStartParam=ref',
      '/a#tgWebAppData=[masked]&tgWebAppStartParam=ref',
    ],
    ['token: abc', 'token: [masked]'],
    ['/a?reset_token=x', '/a?reset_token=[masked]'],
    ['/a?client_secret=x&api_key=y', '/a?client_secret=[masked]&api_key=[masked]'],
    ['/a?X-Amz-Signature=x', '/a?X-Amz-Signature=[masked]'],
    ['/a?token[0]=x', '/a?token[0]=[masked]'],
    ['Authorization: Bearer abc', 'Authorization: [masked] [masked]'],
    ['/a?code=abc&amp;state=def', '/a?code=[masked]&amp;state=[masked]'],
    ['/docs/token:abc', '/docs/token:abc'],
    ['/plain/path', '/plain/path'],
  ])('%s', (input, expected) => {
    expect(redactTrackingText(input)).toBe(expected);
  });

  test('a secret inside a campaign value is found, and clean encoding stays', () => {
    const nested = `/a?next=${encodeURIComponent('/b?token=abc')}`;
    expect(decodeURIComponent(redactTrackingText(nested))).toContain('token=[masked]');
    const clean = `/a?next=${encodeURIComponent('/b?x=1')}`;
    expect(redactTrackingText(clean)).toBe(clean);
  });

  test('a hostile text is cut before the patterns run', () => {
    const started = performance.now();
    for (const character of ['?', '.', '[']) {
      expect(redactTrackingText(character.repeat(1_000_000)).length).toBe(16_384);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('a value keeps its shape, and a secret key masks whatever it holds', () => {
    expect(
      redactTrackingValue({
        token: { deep: 1 },
        list: ['/a?pwd=1', 2],
        keep: true,
        none: null,
      }),
    ).toEqual({ token: '[masked]', list: ['/a?pwd=[masked]', 2], keep: true, none: null });
  });
});

describe('stored attribution', () => {
  const storage = (value: unknown) => {
    const stored = new Map([['stitchkit:attribution', JSON.stringify(value)]]);
    return {
      stored,
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, item: string) => void stored.set(key, item),
      removeItem: (key: string) => void stored.delete(key),
    };
  };

  test.each([
    [{ firstTouch: { data: {}, capturedAt: 'x' }, currentTouch: { data: {}, capturedAt: 1 } }],
    [{ firstTouch: { data: {}, capturedAt: 1 } }],
    [
      {
        firstTouch: { data: { utm: { source: 'x'.repeat(201) } }, capturedAt: 1 },
        currentTouch: { data: {}, capturedAt: 1 },
      },
    ],
  ])('a stored value that does not fit starts over: %#', (value) => {
    const key = 'attribution';
    const held = storage(value);
    held.stored.set(key, JSON.stringify(value));
    const resolved = resolveAttribution({
      search: '?utm_source=new',
      referrer: '',
      pathname: '/',
      hostname: 'shop.example',
      storage: held,
      storageKey: key,
      now: 1_000,
    });
    expect(resolved.firstTouch.utm?.source).toBe('new');
  });
});

describe('trackingTelemetryHealth', () => {
  const report = (stream: string, dropped: number, state = 'available' as const) => ({
    stream,
    state,
    queued: 1,
    dropped,
  });

  test('a lifetime count repeated by every visit counts once, and only by its growth', () => {
    const reports = [report('a', 5), report('a', 5), report('a', 7), report('b', 0)];
    expect(trackingTelemetryHealth(reports, new Map([['a', 5]]))).toMatchObject({
      status: 'degraded',
      dropped: 2,
      queued: 2,
    });
    expect(trackingTelemetryHealth([report('a', 5)], new Map([['a', 5]])).status).toBe('ok');
  });

  test('no reports, or only unknown ones, is not a clean bill of health', () => {
    expect(trackingTelemetryHealth([]).status).toBe('unknown');
    expect(
      trackingTelemetryHealth([{ stream: 'a', state: 'unknown', queued: 0, dropped: 0 }])
        .status,
    ).toBe('unknown');
  });

  test('an unavailable outbox is a degradation', () => {
    expect(
      trackingTelemetryHealth([{ stream: 'a', state: 'unavailable', queued: 0, dropped: 0 }])
        .status,
    ).toBe('degraded');
  });
});
