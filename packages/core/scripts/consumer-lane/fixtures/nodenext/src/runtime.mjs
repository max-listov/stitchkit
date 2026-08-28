import assert from 'node:assert/strict';
import { createClient, defineContract } from 'stitchkit';
import { z } from 'zod';

const queryContract = defineContract(
  { prefix: '/query' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'Query through an injected delivery adapter',
      input: z.object({ cursor: z.string().optional() }),
      output: z.object({ items: z.array(z.string()) }),
    },
  },
);
const workContract = defineContract(
  { prefix: '/work' },
  {
    request: {
      method: 'POST',
      path: '/',
      desc: 'Request work through the same delivery adapter',
      input: z.object({ value: z.string() }),
      output: z.object({ accepted: z.boolean() }),
    },
  },
);
const requests = [];
const delivery = async (input, init) => {
  const request = new Request(input, init);
  requests.push({ method: request.method, path: new URL(request.url).pathname });
  return request.method === 'GET'
    ? Response.json({ items: ['one'] })
    : Response.json({ accepted: true });
};
const config = {
  baseUrl: 'https://example.invalid',
  fetch: delivery,
};
const query = createClient(queryContract, config);
const work = createClient(workContract, config);
assert.deepEqual(await query.list({}), { items: ['one'] });
assert.deepEqual(await work.request({ value: 'bounded' }), { accepted: true });
assert.deepEqual(requests, [
  { method: 'GET', path: '/query' },
  { method: 'POST', path: '/work' },
]);
console.log('nodenext HTTP-only consumer: ok');
