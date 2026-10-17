import assert from 'node:assert/strict';
import { defineContract } from 'stitchkit/contract';
import { createHandler, defineRequestIngress, implement } from 'stitchkit/node';
import { z } from 'zod';

const caller = defineRequestIngress('caller');

const contract = defineContract(
  { prefix: 'orders' },
  {
    place: {
      method: 'POST',
      path: '/',
      desc: 'Place an order',
      expose: ['HTTP'],
      input: z.object({ item: z.string() }),
      output: z.object({ node: z.string().nullable() }),
    },
  },
);

const seen = [];
const handler = createHandler({
  services: [implement(contract, { place: (ctx) => ({ node: caller.from(ctx) ?? null }) })],
  hooks: {
    authorize: (ctx) => {
      seen.push(caller.from(ctx));
    },
    onError: (ctx) => {
      seen.push(`error:${caller.from(ctx)}`);
    },
  },
});

const post = (body) =>
  new Request('http://localhost/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const attached = post({ item: 'tea' });
caller.attach(attached, 'node-7');
assert.deepEqual(await (await handler(attached)).json(), { node: 'node-7' });

const invalid = post({ wrong: true });
caller.attach(invalid, 'node-7');
assert.equal((await handler(invalid)).status, 400);

const source = post({ item: 'tea' });
caller.attach(source, 'node-7');
const forged = post({ item: 'tea' });
forged.headers.set('caller', 'node-7');
for (const request of [source.clone(), forged, post({ item: 'tea' })]) {
  assert.deepEqual(await (await handler(request)).json(), { node: null });
}
assert.deepEqual(seen, ['node-7', 'node-7', 'error:node-7', undefined, undefined, undefined]);

console.log('packed request ingress: ok');
