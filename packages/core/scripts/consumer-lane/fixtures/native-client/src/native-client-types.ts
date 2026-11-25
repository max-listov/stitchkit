import type {
  BoundRealtimeClient,
  InferRealtimeEventMap,
  RealtimeClient,
  RealtimeClientTransport,
  RetainedTopics,
} from 'stitchkit/realtime';
import {
  bindRealtimeClient,
  createRealtimeClient,
  createSocketIOClient,
  defineRealtimeContract,
} from 'stitchkit/realtime';
import { z } from 'zod';

const contract = defineRealtimeContract({
  serverToClient: { greeting: { args: z.tuple([z.object({ message: z.string() })]) } },
  clientToServer: {},
});
const client: RealtimeClient<typeof contract.serverToClient, typeof contract.clientToServer> =
  createRealtimeClient(contract, {
    url: 'http://127.0.0.1',
    peers: { client: () => import('socket.io-client') },
  });
client.on('greeting', (value) => {
  const message: string = value.message;
  // @ts-expect-error the contract payload is a string
  const invalid: number = value.message;
  void message;
  void invalid;
});
// @ts-expect-error the Hermes-safe factory requires an explicit peer loader
createRealtimeClient(contract, { url: 'http://127.0.0.1' });
const typedEvents: InferRealtimeEventMap<typeof contract.serverToClient> = {
  greeting: (value) => {
    void value.message;
  },
};
const retained: RetainedTopics<{ greeting: string }> = {
  record: () => undefined,
  replay: () => undefined,
  get: () => undefined,
  clear: () => undefined,
};
// One socket the app already holds carries the bound contract too.
const socket: RealtimeClientTransport = createSocketIOClient({
  url: 'http://127.0.0.1',
  peers: { client: () => import('socket.io-client') },
});
const bound: BoundRealtimeClient<
  typeof contract.serverToClient,
  typeof contract.clientToServer
> = bindRealtimeClient(contract, socket);
bound.on('greeting', (value) => {
  const message: string = value.message;
  // @ts-expect-error the bound contract payload is a string
  const invalid: number = value.message;
  void message;
  void invalid;
});
void typedEvents;
void retained;
