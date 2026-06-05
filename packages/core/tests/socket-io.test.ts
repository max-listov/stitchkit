import { afterAll, describe, expect, test } from 'bun:test';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { createSocketIOClient, type SocketIOClientConfig } from '../src/browser/socket-io';
import { createServer } from '../src/server/create';
import { createSocketIOServer, socketIoLane } from '../src/server/socket-io';
import type { RawRoute } from '../src/server/types';
import { composeWebSocketHandlers, webSocketLane } from '../src/server/websocket';

interface ServerEvents {
  pong: (data: { n: number }) => void;
}
interface ClientEvents {
  ping: (data: { n: number }) => void;
}

const PORT = 9895;
const URL = `http://localhost:${PORT}`;

const sock = await createSocketIOServer<ServerEvents, ClientEvents>({ cors: { origin: '*' } });
sock.io.on('connection', (s) => {
  s.on('ping', (data) => s.emit('pong', { n: data.n + 1 }));
});

const server = createServer({
  port: PORT,
  websocket: sock.websocket,
  rawRoutes: [sock.route],
});

/** Resolve once the client reports a live connection (next `connected` event). */
function whenConnected(client: {
  onConnectionChange(listener: (connected: boolean) => void): () => void;
}): Promise<void> {
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

// ─── ServerOptions passthrough (maxHttpBufferSize → the Bun engine) ──────────

describe('Socket.IO ServerOptions passthrough', () => {
  test('maxHttpBufferSize reaches the Bun engine (websocket.maxPayloadLength)', async () => {
    const big = 5 * 1024 * 1024;
    const handle = await createSocketIOServer<ServerEvents, ClientEvents>({
      cors: { origin: '*' },
      serverOptions: { maxHttpBufferSize: big },
    });
    // On Bun the engine's maxPayloadLength is its maxHttpBufferSize — so a value
    // over the 1 MB default proves the option was forwarded, not dropped.
    expect(handle.websocket.maxPayloadLength).toBe(big);
    handle.io.close();
  });

  test('default maxHttpBufferSize is the 1 MB engine default when omitted', async () => {
    const handle = await createSocketIOServer<ServerEvents, ClientEvents>({
      cors: { origin: '*' },
    });
    expect(handle.websocket.maxPayloadLength).toBe(1e6);
    handle.io.close();
  });
});

// ─── Handshake auth (token / query / headers) ───────────────────────────────

interface Identity {
  token: string;
  room: string | null;
  tenant: string | null;
}
interface AuthServerEvents {
  identity: (info: Identity) => void;
}
interface AuthClientEvents {
  who: () => void;
}

const AUTH_PORT = 9896;
const AUTH_URL = `http://localhost:${AUTH_PORT}`;

const authSock = await createSocketIOServer<AuthServerEvents, AuthClientEvents>({
  cors: { origin: '*' },
});
// Handshake gate — accept the initial token and the rotated one, reject the rest.
authSock.io.use((s, next) => {
  const token = s.handshake.auth.token;
  if (token === 'good' || token === 'rotated-2') next();
  else next(new Error('unauthorized'));
});
authSock.io.on('connection', (s) => {
  s.on('who', () =>
    s.emit('identity', {
      token: String(s.handshake.auth.token),
      room: s.handshake.query.room ? String(s.handshake.query.room) : null,
      tenant: s.handshake.headers['x-tenant'] ? String(s.handshake.headers['x-tenant']) : null,
    }),
  );
});
const authServer = createServer({
  port: AUTH_PORT,
  websocket: authSock.websocket,
  rawRoutes: [authSock.route],
});

function makeAuthClient(config: Partial<SocketIOClientConfig<AuthServerEvents>> = {}) {
  return createSocketIOClient<AuthServerEvents, AuthClientEvents>({
    url: AUTH_URL,
    transports: ['websocket'],
    ...config,
  });
}

describe('Socket.IO handshake auth', () => {
  afterAll(() => {
    authServer.stop(true);
  });

  test('object auth — a valid token connects and reaches handshake.auth', async () => {
    const client = makeAuthClient({ auth: { token: 'good' } });
    const identity = new Promise<Identity>((resolve) => client.on('identity', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('who');

    expect((await identity).token).toBe('good');
    client.disconnect();
  });

  test('object auth — an invalid token is refused (never connects)', async () => {
    const client = makeAuthClient({ auth: { token: 'nope' }, reconnectionDelay: 50 });
    let everConnected = false;
    client.onConnectionChange((connected) => {
      if (connected) everConnected = true;
    });

    client.connect();
    await Bun.sleep(300);

    expect(everConnected).toBe(false);
    expect(client.connected).toBe(false);
    client.disconnect();
  });

  test('function auth is re-read on every (re)connect — a rotated token is picked up', async () => {
    let token = 'good';
    const client = makeAuthClient({ auth: () => ({ token }) });
    const seen: string[] = [];
    // A durable subscription — it must survive the reconnect cycle below.
    client.on('identity', (info) => seen.push(info.token));

    client.connect();
    await whenConnected(client);
    client.emit('who');
    await Bun.sleep(100);

    // Rotate the token, then reconnect through the wrapper. The durable handler
    // survives and the auth function is re-read, so the new token is sent — no
    // client recreation, no lost subscription.
    client.disconnect();
    token = 'rotated-2';
    client.connect();
    await whenConnected(client);
    client.emit('who');
    await Bun.sleep(100);

    expect(seen).toEqual(['good', 'rotated-2']);
    client.disconnect();
  });

  test('async function auth resolves before the handshake', async () => {
    const client = makeAuthClient({
      auth: async () => {
        await Bun.sleep(10);
        return { token: 'good' };
      },
    });
    const identity = new Promise<Identity>((resolve) => client.on('identity', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('who');

    expect((await identity).token).toBe('good');
    client.disconnect();
  });

  test('a failing function auth does not leave the handshake hanging', async () => {
    const client = makeAuthClient({
      auth: async () => {
        throw new Error('token unavailable');
      },
      reconnectionDelay: 50,
    });
    let everConnected = false;
    client.onConnectionChange((connected) => {
      if (connected) everConnected = true;
    });

    client.connect();
    await Bun.sleep(300);

    expect(everConnected).toBe(false);
    expect(client.connected).toBe(false);
    client.disconnect();
  });

  test('query and extraHeaders pass through to the handshake', async () => {
    const client = makeAuthClient({
      auth: { token: 'good' },
      query: { room: 'lobby' },
      extraHeaders: { 'x-tenant': 'acme' },
    });
    const identity = new Promise<Identity>((resolve) => client.on('identity', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('who');

    const info = await identity;
    expect(info.room).toBe('lobby');
    expect(info.tenant).toBe('acme');
    client.disconnect();
  });
});

// ─── Raw binary lane composed beside Socket.IO (Bun) ─────────────────────────

interface EchoData {
  lane: 'echo';
}
function isEchoSocket(ws: ServerWebSocket<unknown>): ws is ServerWebSocket<EchoData> {
  const data = ws.data;
  return typeof data === 'object' && data !== null && 'lane' in data && data.lane === 'echo';
}

const COMPOSE_PORT = 9897;
const COMPOSE_URL = `http://localhost:${COMPOSE_PORT}`;

const composeSock = await createSocketIOServer<ServerEvents, ClientEvents>({
  cors: { origin: '*' },
});
composeSock.io.on('connection', (s) => {
  s.on('ping', (data) => s.emit('pong', { n: data.n + 1 }));
});

// Raw lane: a separate upgrade route stamps the discriminator onto ws.data.
const echoUpgradeRoute: RawRoute = {
  method: 'GET',
  path: '/ws/echo',
  handler: (req, ctx) => {
    if (!ctx.server) throw new Error('[stitchkit] needs a running Bun server');
    const ok = ctx.server.upgrade(req, { data: { lane: 'echo' } });
    return ok ? new Response(null) : new Response(null, { status: 400 });
  },
};
const echoHandlers: WebSocketHandler<EchoData> = {
  open(ws) {
    // Prove ws.data is typed EchoData here — cast-free.
    ws.send(`open:${ws.data.lane}`);
  },
  message(ws, message) {
    ws.send(message);
  },
};

const composedWebSocket = composeWebSocketHandlers(
  [
    webSocketLane({ match: isEchoSocket, handlers: echoHandlers }),
    socketIoLane(composeSock.websocket),
  ],
  { maxPayloadLength: 4 * 1024 * 1024 },
);
const composeServer = createServer({
  port: COMPOSE_PORT,
  websocket: composedWebSocket,
  rawRoutes: [composeSock.route, echoUpgradeRoute],
});

/** Open a native WebSocket to the raw lane, collect `count` messages. */
function rawRoundTrip(payload: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${COMPOSE_PORT}/ws/echo`);
    const messages: string[] = [];
    const timer = setTimeout(() => reject(new Error('raw ws timed out')), 3000);
    ws.addEventListener('message', (event) => {
      messages.push(String(event.data));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.close();
        resolve(messages);
      }
    });
    ws.addEventListener('open', () => ws.send(payload));
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('raw ws error'));
    });
  });
}

describe('composed WebSocket lanes (Socket.IO + raw)', () => {
  afterAll(() => {
    composeServer.stop(true);
  });

  test('the raw lane handles its own sockets', async () => {
    const messages = await rawRoundTrip('hello', 2);
    expect(messages).toEqual(['open:echo', 'hello']);
  });

  test('Socket.IO still round-trips through the same composed handler', async () => {
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: COMPOSE_URL,
      transports: ['websocket'],
    });
    const pong = new Promise<{ n: number }>((resolve) => client.on('pong', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 7 });

    expect(await pong).toEqual({ n: 8 });
    client.disconnect();
  });

  test('both lanes work on the same server, concurrently', async () => {
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: COMPOSE_URL,
      transports: ['websocket'],
    });
    const pong = new Promise<{ n: number }>((resolve) => client.on('pong', resolve));
    client.connect();
    await whenConnected(client);

    const [raw, _ignore] = await Promise.all([
      rawRoundTrip('concurrent', 2),
      (async () => {
        client.emit('ping', { n: 100 });
        return await pong;
      })(),
    ]);

    expect(raw).toEqual(['open:echo', 'concurrent']);
    expect(await pong).toEqual({ n: 101 });
    client.disconnect();
  });
});

// ─── Sticky events (retained last value) ─────────────────────────────────────

interface StateServerEvents {
  state: (data: { value: number }) => void;
}
interface StateClientEvents {
  noop: () => void;
}

const STICKY_PORT = 9898;
const STICKY_URL = `http://localhost:${STICKY_PORT}`;

const stickySock = await createSocketIOServer<StateServerEvents, StateClientEvents>({
  cors: { origin: '*' },
});
// Publish the current state once, on connect — a subscriber that arrives later
// would miss it without retention.
stickySock.io.on('connection', (s) => {
  s.emit('state', { value: 7 });
});
const stickyServer = createServer({
  port: STICKY_PORT,
  websocket: stickySock.websocket,
  rawRoutes: [stickySock.route],
});

describe('Socket.IO sticky events (retain)', () => {
  afterAll(() => {
    stickyServer.stop(true);
  });

  test('a handler subscribed after the event still gets the last value', async () => {
    const client = createSocketIOClient<StateServerEvents, StateClientEvents>({
      url: STICKY_URL,
      transports: ['websocket'],
      retain: ['state'],
    });
    client.connect();
    await whenConnected(client);
    // Let the connect-time `state` emission arrive and be recorded.
    await Bun.sleep(100);

    // Subscribe *after* the event — the retained value is replayed synchronously.
    const late: Array<{ value: number }> = [];
    client.on('state', (data) => {
      late.push(data);
    });
    expect(late).toEqual([{ value: 7 }]);
    client.disconnect();
  });

  test('the retained value survives a disconnect/connect cycle', async () => {
    const client = createSocketIOClient<StateServerEvents, StateClientEvents>({
      url: STICKY_URL,
      transports: ['websocket'],
      retain: ['state'],
    });
    client.connect();
    await whenConnected(client);
    await Bun.sleep(100);
    client.disconnect();

    // Still replays while disconnected — the store lives outside the socket.
    const afterDisconnect: Array<{ value: number }> = [];
    client.on('state', (data) => {
      afterDisconnect.push(data);
    });
    expect(afterDisconnect).toEqual([{ value: 7 }]);
  });

  test('a non-retained event is not replayed to a late subscriber', async () => {
    const client = createSocketIOClient<StateServerEvents, StateClientEvents>({
      url: STICKY_URL,
      transports: ['websocket'],
      // no `retain` → no stickiness
    });
    client.connect();
    await whenConnected(client);
    await Bun.sleep(100);

    const late: Array<{ value: number }> = [];
    client.on('state', (data) => {
      late.push(data);
    });
    expect(late).toEqual([]);
    client.disconnect();
  });
});
