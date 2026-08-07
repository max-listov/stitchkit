import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { mountAgent } from '../src/tools/agent';

const encoder = new TextEncoder();
const secret = 'webhook-secret';

async function hmac(text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

const webhookContract = defineContract(
  { prefix: 'webhooks' },
  {
    receive: {
      method: 'POST',
      path: '/',
      desc: 'Receive signed event',
      expose: ['HTTP'],
      rawBody: true,
      input: z.object({ event: z.string(), label: z.string() }),
      output: z.object({ verified: z.boolean(), label: z.string() }),
    },
  },
);

describe('rawBody contract endpoints', () => {
  test('verify whitespace-sensitive HMAC while retaining validated input', async () => {
    const body = '{\n  "event": "created",\n  "label": "café ☕"\n}\n';
    const signature = await hmac(body);
    const handler = createHandler({
      services: [
        implement(webhookContract, {
          receive: async (context) => ({
            verified: (await hmac(context.rawBody)) === context.req.headers.get('x-signature'),
            label: context.input.label,
          }),
        }),
      ],
    });

    const response = await handler(
      new Request('http://localhost/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signature },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verified: true, label: 'café ☕' });
  });

  test('retains raw text before JSON and Zod validation for onError', async () => {
    const seen: unknown[] = [];
    const handler = createHandler({
      services: [
        implement(webhookContract, { receive: () => ({ verified: true, label: '' }) }),
      ],
      hooks: {
        onError: (context) => {
          seen.push(context.rawBody);
        },
      },
    });
    const invalidJson = '{"event":';
    const invalidShape = '{ "event": "created" }';

    const jsonResponse = await handler(
      new Request('http://localhost/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: invalidJson,
      }),
    );
    const shapeResponse = await handler(
      new Request('http://localhost/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: invalidShape,
      }),
    );

    expect(jsonResponse.status).toBe(400);
    expect(shapeResponse.status).toBe(400);
    expect(seen).toEqual([invalidJson, invalidShape]);
  });

  test('does not retain a body on an endpoint without the opt-in', async () => {
    let ownsRawBody = true;
    const contract = defineContract(
      { prefix: 'ordinary' },
      {
        receive: {
          method: 'POST',
          path: '/',
          desc: 'Receive event',
          expose: ['HTTP'],
          input: z.object({ event: z.string() }),
        },
      },
    );
    const handler = createHandler({
      services: [
        implement(contract, {
          receive: (context) => {
            // @ts-expect-error normal endpoints do not guarantee a raw body
            const rawBody: string = context.rawBody;
            void rawBody;
            ownsRawBody = Object.hasOwn(context, 'rawBody');
          },
        }),
      ],
    });
    const response = await handler(
      new Request('http://localhost/ordinary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"event":"created"}',
      }),
    );
    expect(response.status).toBe(204);
    expect(ownsRawBody).toBe(false);
  });

  test('enforces server and per-route JSON byte ceilings', async () => {
    const contract = defineContract(
      { prefix: 'limits' },
      {
        inherited: {
          method: 'POST',
          path: '/inherited',
          desc: 'Use server cap',
          expose: ['HTTP'],
          input: z.object({ value: z.string() }),
        },
        overridden: {
          method: 'POST',
          path: '/overridden',
          desc: 'Use route cap',
          expose: ['HTTP'],
          maxJsonBodyBytes: 100,
          input: z.object({ value: z.string() }),
        },
      },
    );
    const handler = createHandler({
      services: [
        implement(contract, { inherited: () => undefined, overridden: () => undefined }),
      ],
      maxJsonBodyBytes: 10,
    });
    const body = '{"value":"long enough"}';
    const request = (path: string) =>
      new Request(`http://localhost/limits/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    const rejected = await handler(request('inherited'));
    const accepted = await handler(request('overridden'));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'JSON body exceeds the 10-byte limit' },
    });
    expect(accepted.status).toBe(204);
  });

  test('is HTTP-only even when expose is omitted', () => {
    const contract = defineContract(
      { prefix: 'implicit-http' },
      {
        receive: {
          method: 'POST',
          path: '/',
          desc: 'Receive signed event',
          rawBody: true,
          input: z.object({ event: z.string() }),
        },
      },
    );
    const service = implement(contract, {
      receive: () => undefined,
    });
    expect(Object.keys(mountAgent(service))).toEqual([]);
  });

  test('rejects incoherent rawBody declarations at definition time', () => {
    expect(() => {
      defineContract(
        { prefix: 'bad', scope: 'public' },
        {
          // @ts-expect-error rawBody is only valid on body-bearing methods
          get: { method: 'GET', path: '/', desc: 'Bad', rawBody: true, input: z.object({}) },
        },
      );
    }).toThrow('must use POST, PUT or PATCH');

    expect(() => {
      defineContract(
        { prefix: 'bad', scope: 'public' },
        {
          // @ts-expect-error rawBody requires an input schema
          missing: { method: 'POST', path: '/', desc: 'Bad', rawBody: true },
        },
      );
    }).toThrow('must declare an input schema');

    expect(() =>
      defineContract(
        { prefix: 'bad' },
        {
          receive: {
            method: 'POST',
            path: '/',
            desc: 'Bad',
            expose: ['HTTP'],
            maxJsonBodyBytes: 0,
            input: z.object({}),
          },
        },
      ),
    ).toThrow('maxJsonBodyBytes must be a positive safe integer');

    expect(() => createHandler({ maxJsonBodyBytes: Number.NaN })).toThrow(
      'HandlerConfig.maxJsonBodyBytes must be a positive safe integer',
    );
  });
});
