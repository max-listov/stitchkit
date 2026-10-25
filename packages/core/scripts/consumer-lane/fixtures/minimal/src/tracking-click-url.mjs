import assert from 'node:assert/strict';
import {
  CONVENTIONAL_TRACKING_EVENT_TYPES,
  createTrackingClient,
  createTrackingOutbox,
  memoryOutboxStorage,
  resolveTrackedClick,
} from 'stitchkit/tracking';

const origin = 'https://shop.example';
const input = '/catalog/item?offer=synthetic&password=synthetic-secret#details';
function link(href) {
  return {
    closest(selector) {
      return selector === 'a[href]' || selector.includes('data-track') ? this : null;
    },
    getAttribute: (key) => ({ href, 'data-track': 'catalog-item' })[key] ?? null,
    textContent: 'Product label',
  };
}
assert.equal(resolveTrackedClick(link(input), { origin })?.click?.href, '/catalog/item');
assert.equal(
  resolveTrackedClick(link(input), { origin, hrefPolicy: 'full' })?.click?.href,
  input,
);
assert.equal(resolveTrackedClick(null, { origin, hrefPolicy: 'full' }), null);

// Redaction is application policy. The native collector exposes the retained
// URL to it before any delivery path, including the synchronous unload path.
function redact(href) {
  const url = new URL(href, origin);
  url.searchParams.delete('password');
  return `${url.origin === origin ? '' : url.origin}${url.pathname}${url.search}${url.hash}`;
}
async function exercise(hrefPolicy) {
  const clicks = new Set();
  const listeners = new Set();
  const timers = new Set();
  const delivered = [];
  const unloaded = [];
  const seen = [];
  const failures = [];
  let sequence = 0;
  const host = {
    page: () => ({
      pathname: '/',
      search: '',
      origin,
      hostname: 'shop.example',
      title: 'Shop',
      referrer: '',
      viewportWidth: 800,
      viewportHeight: 600,
      screenWidth: 800,
      screenHeight: 600,
      displayMode: 'browser',
    }),
    visible: () => true,
    scrollDepth: () => 0,
    on(_event, handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    onClick(handler) {
      clicks.add(handler);
      return () => clicks.delete(handler);
    },
    interval(handler) {
      timers.add(handler);
      return () => timers.delete(handler);
    },
    now: () => 0,
    wallClock: () => 1000,
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    storage: null,
  };
  const outbox = createTrackingOutbox(memoryOutboxStorage(), {
    now: host.wallClock,
    randomUUID: host.randomUUID,
  });
  const client = createTrackingClient({
    host,
    buildId: 'synthetic',
    builtin: CONVENTIONAL_TRACKING_EVENT_TYPES,
    hrefPolicy,
    outbox,
    bootstrap: async () => ({ visitId: 'visit', expiresAt: '2099-01-01T00:00:00Z' }),
    decorate(event) {
      seen.push(structuredClone(event));
      return typeof event.metadata?.href === 'string'
        ? { ...event, metadata: { ...event.metadata, href: redact(event.metadata.href) } }
        : event;
    },
    deliver: async (batch) => {
      delivered.push(structuredClone(batch));
      return {
        accepted: batch.events.length,
        dispositions: batch.events.map(({ eventId }) => ({ eventId, status: 'accepted' })),
      };
    },
    unload: (batch) => {
      unloaded.push(structuredClone(batch));
      return true;
    },
    onFailure: (...failure) => failures.push(failure),
  });
  const stop = client.start();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  await settle();
  assert.equal(clicks.size, 1, 'one native click listener');
  for (const href of [
    input,
    'https://outside.example/catalog?campaign=synthetic&password=synthetic-secret#details',
  ]) {
    for (const click of clicks) click(link(href));
  }
  // This assertion runs before yielding: navigation facts use unload synchronously.
  assert.equal(unloaded.length, 3);
  assert.deepEqual(
    unloaded.flatMap(({ events }) => events.map(({ type }) => type)),
    ['CLICK', 'CLICK', 'OUTBOUND_CLICK'],
  );
  assert.deepEqual(
    seen.map(({ metadata }) => metadata.href),
    hrefPolicy === 'full'
      ? [
          input,
          'https://outside.example/catalog?campaign=synthetic&password=synthetic-secret#details',
          'https://outside.example/catalog?campaign=synthetic&password=synthetic-secret#details',
        ]
      : [
          '/catalog/item',
          'https://outside.example/catalog',
          'https://outside.example/catalog',
        ],
  );
  const safe =
    hrefPolicy === 'full'
      ? [
          '/catalog/item?offer=synthetic#details',
          'https://outside.example/catalog?campaign=synthetic#details',
          'https://outside.example/catalog?campaign=synthetic#details',
        ]
      : [
          '/catalog/item',
          'https://outside.example/catalog',
          'https://outside.example/catalog',
        ];
  assert.deepEqual(
    unloaded.flatMap(({ events }) => events.map(({ metadata }) => metadata.href)),
    safe,
  );
  assert.equal(unloaded[0].events[0].metadata.elementText, 'Product label');
  assert.equal(unloaded[2].events[0].metadata.label, 'Product label');
  for (const click of clicks) click(null);
  await settle();
  // The durable insurance copy is already redacted; its normal delivery reuses it.
  client.track('CHECK', {});
  await settle();
  const normal = delivered
    .flatMap(({ events }) => events)
    .filter(({ metadata }) => typeof metadata?.href === 'string');
  assert.deepEqual(
    normal.map(({ metadata }) => metadata.href),
    safe,
  );
  assert.equal(
    JSON.stringify([...delivered, ...unloaded]).includes('synthetic-secret'),
    false,
  );
  assert.deepEqual(failures, []);
  stop();
  assert.equal(clicks.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
  const count = seen.length;
  for (const click of clicks) click(link(input));
  assert.equal(seen.length, count);
}
await exercise(undefined);
await exercise('path-only');
await exercise('full');
console.log('packed tracking click URL policy: ok');
