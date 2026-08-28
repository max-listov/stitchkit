import assert from 'node:assert/strict';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { createToolInvoker } from 'stitchkit/tools/invoker';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'local' },
  {
    add: {
      method: 'POST',
      path: '/add',
      desc: 'Add two values',
      expose: ['AGENT'],
      toolName: 'local_add',
      input: z.object({ left: z.number(), right: z.number() }),
      output: z.object({ total: z.number() }),
    },
  },
);
const service = implement(contract, {
  add: ({ input }) => ({ total: input.left + input.right, private: true }),
});
const invoker = createToolInvoker(service, { transport: 'AGENT' });

assert.deepEqual(await invoker.invokeOrThrow('local_add', { left: 2, right: 3 }), {
  total: 5,
});
assert.equal(
  (await invoker.invoke('local_add', { left: '2', right: 3 })).code,
  'VALIDATION_ERROR',
);
await assert.rejects(
  () => invoker.invokeOrThrow('missing', {}),
  (error) => error?.code === 'NOT_FOUND',
);
console.log(`packed ${process.versions.bun ? 'Bun' : 'Node'} tool invoker: ok`);
