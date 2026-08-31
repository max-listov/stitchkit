import { expect, test } from 'bun:test';
import { io } from 'socket.io-client';
import { createServer, createSocketIOServer, type SocketIOServerConfig } from '../src/server';

test('Bun websocket-only policy rejects a real polling handshake before consumer authorization', async () => {
  let admitted = 0;
  const socket = await createSocketIOServer({
    transports: ['websocket'],
    cors: { origin: 'http://example.test' },
    allowRequest: () => {
      admitted++;
      return true;
    },
  });
  const server = createServer({ port: 0, socket });
  try {
    const response = await fetch(
      `http://localhost:${server.port}/socket.io/?EIO=4&transport=polling`,
      {
        headers: { origin: 'http://example.test' },
        signal: AbortSignal.timeout(1000),
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://example.test');
    expect(admitted).toBe(0);
    expect(socket.connections()).toBe(0);
    const preflight = await fetch(
      `http://localhost:${server.port}/socket.io/?EIO=4&transport=polling`,
      {
        method: 'OPTIONS',
        headers: { origin: 'http://example.test', 'access-control-request-method': 'POST' },
        signal: AbortSignal.timeout(1000),
      },
    );
    expect(preflight.status).toBe(204);
    expect(admitted).toBe(0);
  } finally {
    await server.shutdown({ gracePeriodMs: 0 });
  }
});

for (const transports of [
  ['websocket'],
  ['polling'],
  ['polling', 'websocket'],
] satisfies NonNullable<SocketIOServerConfig['transports']>[]) {
  test(`Bun admits only ${transports.join('+')} while retaining acknowledgements and consumer policy`, async () => {
    const socket = await createSocketIOServer({
      transports,
      allowRequest: (request) => !new URL(request.url).searchParams.has('deny'),
    });
    socket.io.on('connection', (peer) => {
      peer.on('echo', (value: string, ack: (value: string) => void) => ack(value));
    });
    const server = createServer({ port: 0, socket });
    try {
      for (const transport of ['polling', 'websocket'] satisfies NonNullable<
        SocketIOServerConfig['transports']
      >) {
        const client = io(`http://localhost:${server.port}`, {
          transports: [transport],
          reconnection: false,
          timeout: 1000,
          autoConnect: false,
        });
        try {
          const connected = new Promise<boolean>((resolve) => {
            client.once('connect', () => resolve(true));
            client.once('connect_error', () => resolve(false));
          });
          client.connect();
          expect(await connected).toBe(transports.includes(transport));
          if (client.connected)
            expect(await client.timeout(1000).emitWithAck('echo', transport)).toBe(transport);
        } finally {
          client.disconnect();
        }
      }
      const refused = await fetch(
        `http://localhost:${server.port}/socket.io/?EIO=4&transport=polling&deny=yes`,
      );
      expect(refused.status).toBe(403);
    } finally {
      await server.shutdown({ gracePeriodMs: 0 });
    }
  });
}

test('Bun polling-only policy denies an existing-session websocket upgrade and keeps polling usable', async () => {
  const socket = await createSocketIOServer({ transports: ['polling'] });
  const server = createServer({ port: 0, socket });
  const base = `http://localhost:${server.port}/socket.io/?EIO=4&transport=polling`;
  try {
    const open = await (await fetch(base)).text();
    const session = JSON.parse(open.slice(1));
    const upgrade = new WebSocket(
      `ws://localhost:${server.port}/socket.io/?EIO=4&transport=websocket&sid=${encodeURIComponent(session.sid)}`,
    );
    const outcome = new Promise<string>((resolve) => {
      upgrade.addEventListener('open', () => resolve('open'), { once: true });
      upgrade.addEventListener('error', () => resolve('denied'), { once: true });
    });
    try {
      expect(await outcome).toBe('denied');
    } finally {
      upgrade.close();
    }
    const close = await fetch(`${base}&sid=${encodeURIComponent(session.sid)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '1',
      signal: AbortSignal.timeout(1000),
    });
    expect(close.status).toBe(200);
  } finally {
    await server.shutdown({ gracePeriodMs: 0 });
  }
});
