import { defineContract } from 'stitchkit/contract';
import * as http from 'stitchkit/http';
import { z } from 'zod';

export const contract = defineContract(
  { prefix: 'native' },
  {
    greeting: {
      method: 'GET',
      path: '/hello',
      desc: 'Greet',
      output: z.object({ message: z.string() }),
    },
  },
);
export function client(baseUrl, token) {
  const transport = http.createHttpClient({ baseUrl, headers: { authorization: token } });
  return http.createClients({ api: contract }, transport).api;
}
// Metro retains a barrel's exports. Keep the entire HTTP surface in the compiler proof too.
globalThis.httpSurface = Object.keys(http);
