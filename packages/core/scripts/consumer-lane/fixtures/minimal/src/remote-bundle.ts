import { defineContract } from 'stitchkit/contract';
import { implementRemote } from 'stitchkit/remote';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'remote' },
  {
    ping: {
      method: 'GET',
      path: '/',
      desc: 'Ping remote API',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

export function bindRemote(http: Parameters<typeof implementRemote>[1]) {
  return implementRemote(contract, http);
}
