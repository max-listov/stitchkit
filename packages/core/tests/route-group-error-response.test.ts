import { expect, test } from 'bun:test';
import { AppError, defineContract } from '../src/contract';
import { createObservability, type RequestEvent } from '../src/observability';
import { createHandler, implement, type StitchLogger } from '../src/server';
import { groupErrorRequest, groupErrorService } from './fixtures/route-group-error';

test('group error response preserves CORS, trace and exactly one error completion', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const events: RequestEvent[] = [];
  const write = (_message: string, fields?: Record<string, unknown>) => {
    if (typeof fields?.status === 'number') logs.push(fields);
  };
  const logger: StitchLogger = { info: write, error: write, warn: write, debug: write };
  const observability = createObservability({
    request: {
      write: (event) => {
        events.push(event);
      },
    },
  });
  const handler = createHandler({
    cors: { origin: '*' },
    logging: { logger },
    observability: observability.request,
    groups: [
      {
        pathPrefix: '/group',
        services: [groupErrorService],
        hooks: {
          authorize: () => {
            throw new AppError('FORBIDDEN', 'denied', 403);
          },
          onError: () =>
            new Response('group', { status: 403, headers: { 'cache-control': 'no-store' } }),
        },
      },
    ],
  });
  const response = await handler(groupErrorRequest());
  await Bun.sleep(10);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(logs).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(logs[0]?.status).toBe(403);
  expect(logs[0]?.errorCode).toBe('FORBIDDEN');
  expect(events[0]?.statusCode).toBe(403);
  expect(events[0]?.errorCode).toBe('FORBIDDEN');
  expect(events[0]?.traceId).toBe(response.headers.get('x-request-id') ?? undefined);
  expect(logs[0]?.traceId).toBe(events[0]?.traceId);
});

test('rawResponse contract handler errors still belong to the matched group', async () => {
  const contract = defineContract(
    { prefix: 'raw' },
    {
      get: { method: 'GET', path: '/', desc: 'Raw response', rawResponse: true },
    },
  );
  const service = implement(contract, {
    get: () => {
      throw new Error('handler failure');
    },
  });
  const handler = createHandler({
    groups: [
      {
        pathPrefix: '/group',
        services: [service],
        hooks: {
          onError: (_ctx, _error, endpoint) => new Response(endpoint?.key, { status: 503 }),
        },
      },
    ],
  });
  const response = await handler(new Request('http://localhost/group/raw'));
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('get');
});
