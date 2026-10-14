import type {
  InferRealtimeEventMap,
  RealtimeClient,
  RetainedTopics,
} from 'stitchkit/realtime';
import { createRealtimeClient, defineRealtimeContract } from 'stitchkit/realtime';
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
void typedEvents;
void retained;
