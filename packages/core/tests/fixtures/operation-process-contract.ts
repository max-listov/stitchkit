import { z } from 'zod';
import { defineContract } from '../../src/entrypoints/contract';

export const heavyContract = defineContract(
  { prefix: 'heavy' },
  {
    search: {
      method: 'POST',
      path: '/search',
      desc: 'A scan that holds its process',
      input: z.object({
        query: z.string().min(1),
        busyMs: z.number().optional(),
        mode: z.enum(['big', 'hang', 'refuse', 'noisy', 'crash']).optional(),
        pidFile: z.string().optional(),
        padding: z.string().optional(),
      }),
      output: z.object({ matches: z.array(z.string()) }),
    },
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'A cheap operation on the same server',
      output: z.object({ ok: z.boolean() }),
    },
    follow: {
      method: 'POST',
      path: '/follow',
      desc: 'Items as the process produces them',
      input: z.object({
        count: z.number(),
        gapMs: z.number().optional(),
        mode: z.enum(['refuse', 'big']).optional(),
      }),
      stream: { item: z.object({ n: z.number(), text: z.string().optional() }) },
    },
    linger: {
      method: 'POST',
      path: '/linger',
      desc: 'A stream that outlives its declared lifetime',
      input: z.object({ pidFile: z.string() }),
      stream: { item: z.object({ n: z.number() }), lifetimeMs: 400 },
    },
  },
);
