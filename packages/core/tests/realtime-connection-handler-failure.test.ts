import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createRealtimeClient } from '../src/browser/socket-io';
import { defineRealtimeContract } from '../src/realtime';
import { createServer } from '../src/server/bun';
import { bindRealtimeServer } from '../src/server/realtime';
import { createSocketIOServer } from '../src/server/socket-io';
import { until } from './session-delivery-fixture';

const contract = defineRealtimeContract({
  serverToClient: {},
  clientToServer: {
    ping: { args: z.tuple([z.string()]), ack: z.object({ pong: z.string() }) },
  },
});

test('a connection handler that throws closes that connection and leaves the server up', async () => {
  const handle = await createSocketIOServer({ cors: { origin: '*' } });
  const logged: string[] = [];
  const realtime = bindRealtimeServer(contract, handle, {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message) => {
        logged.push(message);
      },
    },
  });
  let connections = 0;
  realtime.onConnection(({ events }) => {
    connections += 1;
    if (connections === 1) throw new Error('handler bug');
    events.on('ping', (text, acknowledge) => acknowledge({ pong: text }));
  });
  const server = createServer({ port: 0, socket: handle });
  const connect = () => {
    const client = createRealtimeClient(contract, {
      url: `http://localhost:${server.port}`,
      transports: ['websocket'],
      reconnectionAttempts: 0,
    });
    const changes: boolean[] = [];
    client.onConnectionChange((live) => {
      changes.push(live);
    });
    client.connect();
    return { client, changes };
  };
  try {
    const failed = connect();
    await until(() => failed.changes.includes(false));
    expect(logged).toEqual(['Realtime connection handler failed']);
    failed.client.disconnect();

    const healthy = connect();
    await until(() => healthy.changes.includes(true));
    expect(await healthy.client.request('ping', 'still here', { timeoutMs: 5_000 })).toEqual({
      pong: 'still here',
    });
    healthy.client.disconnect();
  } finally {
    await server.shutdown({ gracePeriodMs: 0 });
  }
});
