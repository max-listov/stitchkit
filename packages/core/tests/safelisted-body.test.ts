/**
 * `safelistedBody: true` — a JSON body accepted under `text/plain`, the media
 * type a dying document can still send to another origin without a preflight.
 *
 * The flag is an opening in a CSRF wall, so most of this file is about what
 * stays shut: the wrong method, the wrong media type without the flag, and —
 * with the flag — every request whose `Origin` the server did not name.
 * → ADR 0165.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { isOriginAllowed } from '../src/server/middleware/cors';
import { generateOpenApiDocument } from '../src/server/openapi';
import type { HandlerConfig } from '../src/server/types';
import { listToolNames } from '../src/tools/list-names';

const Event = z.object({ type: z.string(), page: z.string() });

const tracking = defineContract(
  { prefix: 'tracking', scope: 'public' },
  {
    track: {
      method: 'POST',
      path: '/events',
      desc: 'Batch track browser events',
      input: z.object({ events: z.array(Event).min(1) }),
      output: z.object({ accepted: z.number() }),
      safelistedBody: true,
      maxJsonBodyBytes: 200,
    },
    plain: {
      method: 'POST',
      path: '/plain',
      desc: 'An ordinary JSON endpoint beside the safelisted one',
      input: z.object({ events: z.array(Event).min(1) }),
      output: z.object({ accepted: z.number() }),
    },
  },
);

function handlerWith(cors: HandlerConfig['cors']) {
  const seen: unknown[] = [];
  const handler = createHandler({
    services: [
      implement(tracking, {
        track: ({ input }) => {
          seen.push(input);
          return { accepted: input.events.length };
        },
        plain: ({ input }) => ({ accepted: input.events.length }),
      }),
    ],
    ...(cors ? { cors } : {}),
  });
  return { handler, seen };
}

const body = JSON.stringify({ events: [{ type: 'PAGE_LEAVE', page: '/' }] });

function post(path: string, headers: Record<string, string>, payload = body): Request {
  return new Request(`http://localhost/tracking${path}`, {
    method: 'POST',
    headers,
    body: payload,
  });
}

const ALLOWED = 'https://school.example.com';
const beaconHeaders = (origin?: string): Record<string, string> => ({
  'content-type': 'text/plain;charset=UTF-8',
  ...(origin === undefined ? {} : { origin }),
});

describe('contract-time refusals', () => {
  const refused: Array<{ name: string; def: Record<string, unknown>; message?: string }> = [
    { name: 'GET', def: { method: 'GET', input: z.object({}) } },
    { name: 'PUT', def: { method: 'PUT', input: z.object({}) } },
    { name: 'PATCH', def: { method: 'PATCH', input: z.object({}) } },
    { name: 'DELETE', def: { method: 'DELETE', input: z.object({}) } },
    {
      name: 'HEAD',
      def: { method: 'HEAD', rawResponse: true, safelistedBody: true },
      message: 'must use POST',
    },
    {
      name: 'without input',
      def: { method: 'POST' },
      message: 'must declare an input schema',
    },
    {
      name: 'multipart',
      def: {
        method: 'POST',
        input: z.object({}),
        multipart: { files: { file: { maxBytes: 10 } } },
      },
      message: 'cannot be multipart',
    },
    {
      name: 'streaming',
      def: { method: 'POST', input: z.object({}), stream: { item: z.object({}) } },
      message: 'cannot be a streaming response',
    },
  ];

  test.each(refused)('$name is refused', ({ def, message = 'must use POST' }) => {
    expect(() =>
      defineContract(
        { prefix: 'x' },
        {
          // The shapes a type-level `never` cannot reach — `EndpointDefBase`
          // admits every method — are exactly what the runtime assertion is for.
          bad: { path: '/', desc: 'bad', safelistedBody: true, ...def } as never,
        },
      ),
    ).toThrow(message);
  });

  test('a valid POST with input is accepted and stays transport-neutral', () => {
    // Unlike `rawBody`, the flag does not force `expose: ['HTTP']` — a beacon
    // endpoint may still be a tool; only HTTP body parsing changes.
    const service = implement(tracking, {
      track: () => ({ accepted: 0 }),
      plain: () => ({ accepted: 0 }),
    });
    expect(listToolNames({ services: [service] }).map((entry) => entry.name)).toContain(
      'track_tracking',
    );
  });
});

describe('without the flag, nothing changes', () => {
  test('text/plain is still refused as it always was, allow-listed origin or not', async () => {
    const { handler } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/plain', beaconHeaders(ALLOWED)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: 'Request body must be application/json' },
    });
  });
});

describe('with the flag', () => {
  test('a text/plain body from an allow-listed origin is parsed and validated', async () => {
    const { handler, seen } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/events', beaconHeaders(ALLOWED)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(seen).toEqual([{ events: [{ type: 'PAGE_LEAVE', page: '/' }] }]);
  });

  test('the allow-list may be a list, and the comparison ignores case', async () => {
    const { handler } = handlerWith({ origin: ['https://other.example', ALLOWED] });
    const response = await handler(post('/events', beaconHeaders(ALLOWED.toUpperCase())));
    expect(response.status).toBe(200);
  });

  test('application/json still works and is never subject to the origin check', async () => {
    const { handler } = handlerWith({ origin: ALLOWED });
    const response = await handler(
      post('/events', { 'content-type': 'application/json', origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(200);
  });

  test('a text/plain body from a foreign origin is refused before parsing', async () => {
    const { handler, seen } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/events', beaconHeaders('https://evil.example')));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        message: 'A text/plain body is accepted only from an allowed origin',
      },
    });
    expect(seen).toEqual([]);
  });

  test('Origin: null names no site and is refused', async () => {
    const { handler } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/events', beaconHeaders('null')));
    expect(response.status).toBe(403);
  });

  test('a text/plain body without an Origin header is refused', async () => {
    const { handler } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/events', beaconHeaders()));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: 'A text/plain body requires an Origin header' },
    });
  });

  test("cors.origin: '*' is not an allow-list — a simple request carries cookies from any site", async () => {
    const { handler } = handlerWith({ origin: '*' });
    const response = await handler(post('/events', beaconHeaders(ALLOWED)));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        message: 'A text/plain body requires an explicit cors.origin allow-list on the server',
      },
    });
  });

  test('a server without cors has no allow-list and refuses', async () => {
    const { handler } = handlerWith(undefined);
    const response = await handler(post('/events', beaconHeaders(ALLOWED)));
    expect(response.status).toBe(403);
  });

  test('maxJsonBodyBytes bounds text/plain exactly as it bounds JSON', async () => {
    const { handler } = handlerWith({ origin: ALLOWED });
    const oversized = JSON.stringify({
      events: [{ type: 'PAGE_LEAVE', page: '/'.padEnd(400, 'x') }],
    });
    const asText = await handler(post('/events', beaconHeaders(ALLOWED), oversized));
    const asJson = await handler(
      post('/events', { 'content-type': 'application/json' }, oversized),
    );
    expect(asText.status).toBe(400);
    expect(asJson.status).toBe(400);
    const textMessage = (await asText.json()).error.message;
    const jsonMessage = (await asJson.json()).error.message;
    expect(textMessage).toBe(jsonMessage);
    expect(jsonMessage).toContain('exceeds the 200-byte limit');
  });

  test('an empty text/plain body is `{}`, refused by the schema, not by the origin check', async () => {
    // The origin check guards a body; an empty one is what an ordinary empty
    // POST already is, so it reaches validation and fails there like any other.
    const { handler } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/events', beaconHeaders('https://evil.example'), ''));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('the media type is compared whole, never as a substring', () => {
  // `text/plain; charset=application/json` has the essence `text/plain`: the
  // browser sends it from any site with cookies and no preflight. A substring
  // test read it as JSON and let it through both walls.
  const smuggled = {
    'content-type': 'text/plain; charset=application/json',
    origin: 'https://evil.example',
  };

  test('on a safelisted endpoint it is a text/plain body and meets the Origin gate', async () => {
    const { handler, seen } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/events', smuggled));
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test('on an ordinary endpoint it is refused as it always should have been', async () => {
    const { handler } = handlerWith({ origin: ALLOWED });
    const response = await handler(post('/plain', smuggled));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(
      'Request body must be application/json',
    );
  });

  test('parameters and casing on a real JSON type still pass', async () => {
    const { handler } = handlerWith({ origin: ALLOWED });
    const response = await handler(
      post('/plain', { 'content-type': 'Application/JSON; charset=utf-8' }),
    );
    expect(response.status).toBe(200);
  });
});

describe('isOriginAllowed', () => {
  test('answers only for a named site on an explicit list', () => {
    expect(isOriginAllowed({ origin: ALLOWED }, ALLOWED)).toBe(true);
    expect(isOriginAllowed({ origin: ALLOWED }, 'https://evil.example')).toBe(false);
    expect(isOriginAllowed({ origin: [ALLOWED] }, ALLOWED.toUpperCase())).toBe(true);
    expect(isOriginAllowed({ origin: '*' }, ALLOWED)).toBe(false);
    expect(isOriginAllowed({ origin: ALLOWED }, 'null')).toBe(false);
    expect(isOriginAllowed({ origin: ALLOWED }, null)).toBe(false);
    expect(isOriginAllowed(undefined, ALLOWED)).toBe(false);
  });
});

describe('what the flag is visible through', () => {
  test('OpenAPI lists text/plain beside application/json with one schema', () => {
    const service = implement(tracking, {
      track: () => ({ accepted: 0 }),
      plain: () => ({ accepted: 0 }),
    });
    const spec = generateOpenApiDocument({
      info: { title: 'x', version: '1' },
      services: [service],
    }) as never as {
      paths: Record<
        string,
        { post: { requestBody: { content: Record<string, { schema: unknown }> } } }
      >;
    };
    const content = spec.paths['/tracking/events']?.post.requestBody.content ?? {};
    expect(Object.keys(content).sort()).toEqual(['application/json', 'text/plain']);
    expect(content['text/plain']?.schema).toEqual(content['application/json']?.schema);
    expect(Object.keys(spec.paths['/tracking/plain']?.post.requestBody.content ?? {})).toEqual(
      ['application/json'],
    );
  });
});
