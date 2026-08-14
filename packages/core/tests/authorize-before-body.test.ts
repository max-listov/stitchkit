import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, unauthorized } from '../src/contract';
import { createHandler, implement } from '../src/server';

const contract = defineContract(
  { prefix: 'probes', scope: 'private' },
  {
    json: {
      method: 'POST',
      path: '/:id/json',
      desc: 'Probe JSON authorization ordering',
      params: z.object({ id: z.uuid() }),
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    },
    upload: {
      method: 'POST',
      path: '/:id/upload',
      desc: 'Probe multipart authorization ordering',
      params: z.object({ id: z.uuid() }),
      input: z.object({ title: z.string() }),
      output: z.object({ size: z.number() }),
      multipart: { files: { file: {} } },
    },
  },
);

function bodyProbe(value: string): { body: ReadableStream<Uint8Array>; reads: () => number } {
  let reads = 0;
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  return {
    body: new ReadableStream({
      pull(controller) {
        reads += 1;
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 1));
        offset += 1;
      },
    }),
    reads: () => reads,
  };
}

describe('HTTP authorize phase', () => {
  test('rejects JSON and multipart requests without reading a body chunk', async () => {
    const service = implement(contract, {
      json: ({ input }) => input,
      upload: ({ files }) => ({ size: files.file.size }),
    });
    const handler = createHandler({
      services: [service],
      hooks: { authorize: () => unauthorized('Denied before body') },
    });

    const json = bodyProbe('{"value":"secret"}');
    const jsonRequest = new Request(
      'http://localhost/probes/550e8400-e29b-41d4-a716-446655440000/json',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json.body,
      },
    );
    const jsonResponse = await handler(jsonRequest);
    expect(jsonResponse.status).toBe(401);
    expect(jsonRequest.bodyUsed).toBe(false);

    const multipart = bodyProbe('a'.repeat(1024 * 1024));
    const multipartRequest = new Request(
      'http://localhost/probes/550e8400-e29b-41d4-a716-446655440000/upload',
      {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=probe' },
        body: multipart.body,
      },
    );
    const multipartResponse = await handler(multipartRequest);
    expect(multipartResponse.status).toBe(401);
    expect(multipartRequest.bodyUsed).toBe(false);
  });

  test('validates params before authorize and preserves global/group order', async () => {
    const order: string[] = [];
    const service = implement(contract, {
      json: ({ input }) => input,
      upload: ({ files }) => ({ size: files.file.size }),
    });
    const handler = createHandler({
      groups: [
        {
          pathPrefix: 'v1',
          services: [service],
          hooks: { authorize: () => void order.push('group') },
        },
      ],
      hooks: { authorize: () => void order.push('global') },
    });

    const invalid = bodyProbe('{"value":"x"}');
    const invalidRequest = new Request('http://localhost/v1/probes/not-a-uuid/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: invalid.body,
    });
    const invalidResponse = await handler(invalidRequest);
    expect(invalidResponse.status).toBe(400);
    expect(invalidRequest.bodyUsed).toBe(false);
    expect(order).toEqual([]);

    const validResponse = await handler(
      new Request('http://localhost/v1/probes/550e8400-e29b-41d4-a716-446655440000/json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'ok' }),
      }),
    );
    expect(validResponse.status).toBe(200);
    expect(order).toEqual(['global', 'group']);
  });

  test('a global rejection stops group authorize and payload lifecycle', async () => {
    const order: string[] = [];
    const service = implement(contract, {
      json: ({ input }) => input,
      upload: ({ files }) => ({ size: files.file.size }),
    });
    const handler = createHandler({
      groups: [
        {
          pathPrefix: 'v1',
          services: [service],
          hooks: { authorize: () => void order.push('group') },
        },
      ],
      hooks: {
        authorize: () => {
          order.push('global');
          unauthorized();
        },
      },
    });
    const body = bodyProbe('{"value":"x"}');
    const request = new Request(
      'http://localhost/v1/probes/550e8400-e29b-41d4-a716-446655440000/json',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body.body,
      },
    );
    const response = await handler(request);
    expect(response.status).toBe(401);
    expect(order).toEqual(['global']);
    expect(request.bodyUsed).toBe(false);
  });

  test('authorized input is parsed before beforeHandle and handler', async () => {
    const observed: string[] = [];
    const service = implement(contract, {
      json: ({ input }) => {
        observed.push(`handler:${input.value}`);
        return input;
      },
      upload: ({ files }) => ({ size: files.file.size }),
    });
    const handler = createHandler({
      services: [service],
      hooks: {
        authorize: ({ input, files }) => {
          expect(input).toBeUndefined();
          expect(files).toBeUndefined();
          observed.push('authorize');
        },
        beforeHandle: ({ input }) => {
          if (!input || typeof input !== 'object' || !('value' in input)) {
            throw new Error('Expected validated input');
          }
          observed.push(`before:${String(input.value)}`);
        },
      },
    });
    const response = await handler(
      new Request('http://localhost/probes/550e8400-e29b-41d4-a716-446655440000/json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'ready' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(observed).toEqual(['authorize', 'before:ready', 'handler:ready']);
  });

  test('invalid payload after authorize skips beforeHandle and handler', async () => {
    const observed: string[] = [];
    const service = implement(contract, {
      json: ({ input }) => {
        observed.push('handler');
        return input;
      },
      upload: ({ files }) => ({ size: files.file.size }),
    });
    const handler = createHandler({
      services: [service],
      hooks: {
        authorize: () => void observed.push('authorize'),
        beforeHandle: () => void observed.push('before'),
        onError: (_ctx, error) => {
          observed.push('error');
          throw error;
        },
      },
    });
    const response = await handler(
      new Request('http://localhost/probes/550e8400-e29b-41d4-a716-446655440000/json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );
    expect(response.status).toBe(400);
    expect(observed).toEqual(['authorize', 'error']);
  });
});
