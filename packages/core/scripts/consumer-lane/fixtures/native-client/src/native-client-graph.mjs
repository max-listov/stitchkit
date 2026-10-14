import * as contracts from 'stitchkit/contract';
import * as http from 'stitchkit/http';
import * as query from 'stitchkit/react';
import * as realtime from 'stitchkit/realtime';
import { z } from 'zod';

const factory = contracts.createContractFactory();
export const contract = factory.defineContract(
  { prefix: 'native', scope: 'public' },
  {
    greeting: {
      method: 'GET',
      path: '/hello',
      desc: 'Greet',
      output: z.object({ message: z.string() }),
    },
  },
);
export const realtimeContract = realtime.defineRealtimeContract({
  serverToClient: { greeting: { args: z.tuple([z.object({ message: z.string() })]) } },
  clientToServer: {},
});
export function client(baseUrl, token) {
  const transport = http.createHttpClient({ baseUrl, headers: { authorization: token } });
  return http.createClients({ api: contract }, transport).api;
}
export function realtimeClient(url, token, onConnectError) {
  return realtime.createRealtimeClient(realtimeContract, {
    url,
    auth: { token },
    transports: ['websocket'],
    reconnectionAttempts: 0,
    onConnectError,
    peers: { client: () => import('socket.io-client') },
  });
}
export const queryClient = query.createQueryClientFactory({ server: () => false })();
export const retained = realtime.createRetainedTopics();
export const pageSchema = contracts.paginatedSchema(z.string());
// Retain the whole public native graph, including helpers imported by shared modules.
globalThis.nativeSurface = [http, contracts, query, realtime].map(Object.keys);
