import { z } from 'zod';
import { defineContract } from '../src';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';

export const ResultSchema = z.object({ value: z.string() });
const InputSchema = z.object({ value: z.string() });

export const responseMetadataContract = defineContract(
  { prefix: 'meta' },
  {
    data: {
      method: 'POST',
      path: '/data',
      desc: 'Return typed data and response metadata',
      input: InputSchema,
      output: ResultSchema,
      responseMeta: { status: 201 },
    },
    empty: {
      method: 'POST',
      path: '/empty',
      desc: 'Return an empty response',
      responseMeta: {},
    },
    reset: {
      method: 'POST',
      path: '/reset',
      desc: 'Return an explicit empty status',
      responseMeta: { status: 205 },
    },
    parallel: {
      method: 'POST',
      path: '/parallel',
      desc: 'Prove metadata isolation',
      input: z.object({ value: z.string(), delay: z.number() }),
      output: ResultSchema,
      responseMeta: {},
    },
    signed: {
      method: 'POST',
      path: '/signed',
      desc: 'Retain raw JSON and attach metadata',
      input: InputSchema,
      output: ResultSchema,
      rawBody: true,
      responseMeta: {},
    },
    fail: {
      method: 'POST',
      path: '/fail',
      desc: 'Throw after collecting metadata',
      output: ResultSchema,
      responseMeta: {},
    },
    invalidOutput: {
      method: 'POST',
      path: '/invalid-output',
      desc: 'Fail output validation',
      output: ResultSchema,
      responseMeta: {},
    },
    transformed: {
      method: 'POST',
      path: '/transformed',
      desc: 'Transform data beside metadata',
      output: ResultSchema,
      responseMeta: {},
    },
    hookFail: {
      method: 'POST',
      path: '/hook-fail',
      desc: 'Throw from an after hook',
      output: ResultSchema,
      responseMeta: {},
    },
    reserved: {
      method: 'POST',
      path: '/reserved',
      desc: 'Reject a framework-owned header',
      input: z.object({ name: z.string() }),
      output: ResultSchema,
      responseMeta: {},
    },
  },
);

export const responseMetadataService = implement(responseMetadataContract, {
  data: ({ input, req, response }) => {
    if (!(req instanceof Request)) throw new Error('Expected an HTTP Request');
    response.headers.set('x-operation', input.value);
    response.headers.append('Set-Cookie', `first=${input.value}; Path=/; HttpOnly`);
    response.headers.append('Set-Cookie', `second=${input.value}; Path=/; SameSite=Lax`);
    return { value: input.value };
  },
  empty: ({ response }) => {
    response.headers.set('x-empty', 'yes');
  },
  reset: () => undefined,
  parallel: async ({ input, response }) => {
    response.headers.set('x-call', input.value);
    await Bun.sleep(input.delay);
    return { value: input.value };
  },
  signed: ({ input, rawBody, response }) => {
    response.headers.set('x-raw-length', String(rawBody.length));
    return { value: input.value };
  },
  fail: ({ response }) => {
    response.headers.append('Set-Cookie', 'must-not-leak=true');
    throw new Error('handler failed');
  },
  invalidOutput: ({ response }) => {
    response.headers.append('Set-Cookie', 'must-not-leak=true');
    return { value: 'valid-before-hook' };
  },
  transformed: ({ response }) => {
    response.headers.set('x-before-transform', 'kept');
    return { value: 'before' };
  },
  hookFail: ({ response }) => {
    response.headers.append('Set-Cookie', 'must-not-leak=true');
    return { value: 'before-hook' };
  },
  reserved: ({ input, response }) => {
    response.headers.set(input.name, 'forged');
    return { value: 'blocked' };
  },
});

export function createResponseMetadataTestHandler() {
  return createHandler({
    services: [responseMetadataService],
    hooks: {
      afterHandle: (_context, result, endpoint) => {
        if (endpoint.key === 'invalidOutput') return { wrong: true };
        if (endpoint.key === 'transformed') return { value: 'after' };
        if (endpoint.key === 'hookFail') throw new Error('hook failed');
        return result;
      },
    },
    cors: { origin: 'https://app.example.com' },
  });
}

export function postMetadata(
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/meta/${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
