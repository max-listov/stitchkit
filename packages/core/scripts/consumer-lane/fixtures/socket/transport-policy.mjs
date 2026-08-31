import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { serveNode } from 'stitchkit/node';
import { createServer, createSocketIOServer } from 'stitchkit/server';

for (const transports of [['websocket'], ['polling'], ['polling', 'websocket']]) {
  let authorized = 0;
  const socket = await createSocketIOServer({
    transports,
    cors: { origin: 'http://example.test' },
    allowRequest: (request) => {
      authorized++;
      return !new URL(request.url).searchParams.has('deny');
    },
  });
  socket.io.on('connection', (peer) => {
    peer.on('echo', (value, ack) => ack(value));
  });
  const config = { port: 0, hostname: '127.0.0.1', socket };
  const server = process.versions.bun ? createServer(config) : await serveNode(config);
  const url = `http://127.0.0.1:${server.port}`;
  try {
    if (!transports.includes('polling')) {
      const response = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, {
        headers: { origin: 'http://example.test' },
        signal: AbortSignal.timeout(1000),
      });
      assert.ok(response.status >= 400, 'polling must not be admitted');
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://example.test');
      assert.equal(authorized, 0, 'transport denial must precede consumer authorization');
      assert.equal(socket.connections(), 0);
    }
    for (const transport of ['websocket', 'polling']) {
      const client = io(url, {
        transports: [transport],
        autoConnect: false,
        timeout: 1000,
        reconnection: false,
      });
      try {
        const connected = new Promise((resolve) => {
          client.once('connect', () => resolve(true));
          client.once('connect_error', () => resolve(false));
        });
        client.connect();
        assert.equal(await connected, transports.includes(transport));
        if (client.connected)
          assert.equal(await client.timeout(1000).emitWithAck('echo', transport), transport);
      } finally {
        client.disconnect();
      }
    }
    if (transports.includes('polling')) {
      const refusal = await fetch(`${url}/socket.io/?EIO=4&transport=polling&deny=yes`, {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(refusal.status, 403, 'consumer policy remains enforced');
    }
  } finally {
    await server.shutdown({ gracePeriodMs: 0 });
  }
}
console.log('packed socket transport policy: ok');
