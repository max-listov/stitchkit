import { afterAll, describe, expect, test } from 'bun:test';
import { createSocketIOClient } from '../src/browser/socket-io';
import { createServer } from '../src/server/create';
import { createSocketIOServer } from '../src/server/socket-io';

interface ServerEvents {
  pong: (data: { n: number }) => void;
}
interface ClientEvents {
  ping: (data: { n: number }) => void;
}

const PORT = 9895;
const URL = `http://localhost:${PORT}`;

const sock = createSocketIOServer<ServerEvents, ClientEvents>({ cors: { origin: '*' } });
sock.io.on('connection', (s) => {
  s.on('ping', (data) => s.emit('pong', { n: data.n + 1 }));
});

const server = createServer({
  port: PORT,
  websocket: sock.websocket,
  rawRoutes: [sock.route],
});

/** Resolve once the client reports a live connection. */
function whenConnected(client: ReturnType<typeof makeClient>): Promise<void> {
  return new Promise((resolve) => {
    const off = client.onConnectionChange((connected) => {
      if (connected) {
        off();
        resolve();
      }
    });
  });
}

function makeClient() {
  return createSocketIOClient<ServerEvents, ClientEvents>({
    url: URL,
    transports: ['websocket'],
  });
}

describe('Socket.IO wrappers', () => {
  afterAll(() => {
    server.stop(true);
  });

  test('server handle exposes a ready /socket.io/* route', () => {
    expect(sock.route.method).toBe('ALL');
    expect(sock.route.path).toBe('/socket.io/*');
  });

  test('route fails loud when mounted without a Bun server', () => {
    expect(() => sock.route.handler(new Request(`${URL}/socket.io/`), { params: {} })).toThrow(
      /needs a running Bun server/,
    );
  });

  test('client round-trip — emit ping, receive typed pong', async () => {
    const client = makeClient();
    const pong = new Promise<{ n: number }>((resolve) => {
      client.on('pong', resolve);
    });

    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 41 });

    expect(await pong).toEqual({ n: 42 });
    client.disconnect();
  });

  test('subscription is durable across a disconnect/connect cycle', async () => {
    const client = makeClient();
    const received: number[] = [];
    client.on('pong', (data) => received.push(data.n));

    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 1 });
    await Bun.sleep(100);

    client.disconnect();
    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 10 });
    await Bun.sleep(100);

    client.disconnect();
    expect(received).toEqual([2, 11]);
  });

  test('emit while disconnected is a silent no-op', () => {
    const client = makeClient();
    expect(() => client.emit('ping', { n: 0 })).not.toThrow();
    expect(client.connected).toBe(false);
  });
});
