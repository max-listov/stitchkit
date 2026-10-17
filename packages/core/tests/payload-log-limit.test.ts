import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { createObservability, type RequestEvent } from '../src/entrypoints/observability';
import { createHandler, implement } from '../src/entrypoints/server';

const contract = defineContract(
  { prefix: 'items' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create item',
      input: z.object({ name: z.string() }),
      output: z.object({ name: z.string() }),
    },
  },
);

test('the audit payload read does not drain a body the handler refused at its own limit', async () => {
  const events: RequestEvent[] = [];
  const observability = createObservability({
    request: { write: (event) => void events.push(event), includePayload: true },
  });
  const handler = createHandler({
    services: [implement(contract, { create: ({ input }) => ({ name: input.name }) })],
    observability: observability.request,
    maxJsonBodyBytes: 1024,
  });
  const chunk = 64 * 1024;
  const total = 64 * 1024 * 1024;
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= total) return controller.close();
      state.pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x20));
    },
  });
  const request = new Request('http://localhost/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);

  const response = await handler(request);
  expect(await observability.flush()).toBe(true);

  expect(response.status).toBe(400);
  // The handler's branch stops at 1 KiB and the audit branch at the same limit: neither reads the 64 MiB.
  expect(state.pulled).toBeLessThan(8 * 1024 * 1024);
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).toBeNull();
  expect(events[0]?.payloadTruncated).toBe(true);
});

function auditedHandler(request: { payloadMaxBytes?: number }, maxJsonBodyBytes?: number) {
  const events: RequestEvent[] = [];
  const observability = createObservability({
    request: { write: (event) => void events.push(event), includePayload: true, ...request },
  });
  const handler = createHandler({
    services: [implement(contract, { create: ({ input }) => ({ name: input.name }) })],
    observability: observability.request,
    ...(maxJsonBodyBytes !== undefined && { maxJsonBodyBytes }),
  });
  return { events, handler, flush: () => observability.flush() };
}

const jsonBody = (bytes: number) => JSON.stringify({ name: 'x'.repeat(bytes - 11) });
const post = (body: string) =>
  new Request('http://localhost/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

test('the audit limit follows maxJsonBodyBytes, and a cut body is marked truncated', async () => {
  const { events, handler, flush } = auditedHandler({}, 1024);
  await handler(post(jsonBody(4096)));
  expect(await flush()).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).toBeNull();
  expect(events[0]?.payloadTruncated).toBe(true);
});

test('a body within the limit is recorded and carries no truncation mark', async () => {
  const { events, handler, flush } = auditedHandler({}, 8192);
  await handler(post(jsonBody(2048)));
  expect(await flush()).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).not.toBeNull();
  expect('payloadTruncated' in (events[0] ?? {})).toBe(false);
});

test('payloadMaxBytes overrides the handler limit in both directions', async () => {
  const wider = auditedHandler({ payloadMaxBytes: 64 * 1024 }, 1024);
  await wider.handler(post(jsonBody(4096)));
  const narrower = auditedHandler({ payloadMaxBytes: 512 }, 8192);
  await narrower.handler(post(jsonBody(2048)));
  expect(await wider.flush()).toBe(true);
  expect(await narrower.flush()).toBe(true);
  expect(wider.events).toHaveLength(1);
  expect(narrower.events).toHaveLength(1);
  // The handler refused the 4 KiB body at 1 KiB, yet the audit row still read it (limit 64 KiB).
  expect(wider.events[0]?.payload).not.toBeNull();
  expect(narrower.events[0]?.payloadTruncated).toBe(true);
});

test('without any limit the audit reads up to 1 MiB', async () => {
  const { events, handler, flush } = auditedHandler({});
  await handler(post(jsonBody(2 * 1024 * 1024)));
  expect(await flush()).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0]?.payloadTruncated).toBe(true);
});

test('a payloadMaxBytes that is not a positive integer is refused when observability is created', () => {
  for (const payloadMaxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      createObservability({ request: { write: () => undefined, payloadMaxBytes } }),
    ).toThrow(/payloadMaxBytes/);
  }
});
