import { type ClientFetch, createClient, defineContract } from 'stitchkit';
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

const delivery: ClientFetch = async () => Response.json({ items: [], accepted: true });
const config = {
  baseUrl: 'https://example.invalid',
  fetch: delivery,
};
const query = createClient(queryContract, config);
const work = createClient(workContract, config);
const queryResult: Promise<{ items: string[] }> = query.list({});
const workResult: Promise<{ accepted: boolean }> = work.request({ value: 'bounded' });
void queryResult;
void workResult;
