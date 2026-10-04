import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';

const exposed = ['HTTP', 'CLI', 'MCP', 'AGENT'];
const ok = z.object({ ok: z.boolean() });
export const contract = defineContract(
  { prefix: 'remote_probe' },
  {
    fail: {
      method: 'POST',
      path: '/fail',
      desc: 'Declared recommendation control',
      expose: exposed,
      tool: { name: 'recommendation_fail' },
      input: z.object({ status: z.number().int(), declared: z.boolean().optional() }),
      output: ok,
    },
    plain: {
      method: 'GET',
      path: '/plain',
      desc: 'Cancellation without arguments',
      expose: exposed,
      tool: { name: 'plain' },
      output: ok,
    },
    input: {
      method: 'POST',
      path: '/input',
      desc: 'Cancellation with arguments',
      expose: exposed,
      tool: { name: 'input' },
      input: z.object({ text: z.string() }),
      output: ok,
    },
    empty: {
      method: 'GET',
      path: '/empty',
      desc: 'Cancellation with an empty schema',
      expose: exposed,
      tool: { name: 'empty' },
      input: z.object({}),
      output: ok,
    },
  },
);
